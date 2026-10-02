import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildPath = join(projectRoot, 'scripts', 'build.mjs');
let failures = 0;
let tests = 0;

async function test(name, run) {
  tests++;
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const question = {
  id: 1,
  difficulty: 'easy',
  category: 'Fire support',
  prompt: 'Which fire support choice fits the situation?',
  options: ['First', 'Second', 'Third', 'Fourth'],
  answer: 2,
  explanation: 'The third choice fits the stated constraints.',
  tags: ['planning'],
  sourceSlides: [13],
};

await test('buildHtml replaces each bank placeholder once and leaves no bank tokens', async () => {
  const { buildHtml } = await import('./build.mjs');
  const template = '<script type="application/json" id="easy">{{EASY_QUESTIONS}}</script><script type="application/json" id="medium">{{MEDIUM_QUESTIONS}}</script><script type="application/json" id="hard">{{HARD_QUESTIONS}}</script>';
  const html = buildHtml(template, { easy: [question], medium: [], hard: [] });
  assert.equal(html.includes('{{EASY_QUESTIONS}}'), false);
  assert.equal(html.includes('{{MEDIUM_QUESTIONS}}'), false);
  assert.equal(html.includes('{{HARD_QUESTIONS}}'), false);
  assert.deepEqual(JSON.parse(html.match(/id="easy">(.*?)<\/script>/)[1]), [question]);
  assert.deepEqual(JSON.parse(html.match(/id="medium">(.*?)<\/script>/)[1]), []);
  assert.deepEqual(JSON.parse(html.match(/id="hard">(.*?)<\/script>/)[1]), []);
});

await test('buildHtml escapes script-closing text in embedded JSON', async () => {
  const { buildHtml } = await import('./build.mjs');
  const template = '<script type="application/json">{{EASY_QUESTIONS}}</script>{{MEDIUM_QUESTIONS}}{{HARD_QUESTIONS}}';
  const html = buildHtml(template, {
    easy: [{ ...question, prompt: '</script><script>alert(1)</script>' }],
    medium: [], hard: [],
  });
  assert.equal(html.includes('</script><script>alert(1)'), false);
  assert.match(html, /\\u003c\/script>/);
  assert.equal(JSON.parse(html.match(/<script type="application\/json">(.*?)<\/script>/)[1])[0].prompt, '</script><script>alert(1)</script>');
});

await test('buildHtml preserves dollar replacement tokens in authored text', async () => {
  const { buildHtml } = await import('./build.mjs');
  const template = '<script type="application/json" id="easy">{{EASY_QUESTIONS}}</script>{{MEDIUM_QUESTIONS}}{{HARD_QUESTIONS}}';
  for (const token of ['$&', '$`', "$'", '$$']) {
    const prompt = `Literal ${token} text must survive the build.`;
    const html = buildHtml(template, { easy: [{ ...question, prompt }], medium: [], hard: [] });
    const embedded = JSON.parse(html.match(/id="easy">(.*?)<\/script>/)[1]);
    assert.equal(embedded[0].prompt, prompt, token);
  }
});

await test('buildHtml rejects duplicated bank placeholders', async () => {
  const { buildHtml } = await import('./build.mjs');
  assert.throws(() => buildHtml('{{EASY_QUESTIONS}}{{EASY_QUESTIONS}}{{MEDIUM_QUESTIONS}}{{HARD_QUESTIONS}}', { easy: [], medium: [], hard: [] }), /EASY_QUESTIONS/);
});

await test('validateQuestion accepts a complete question', async () => {
  const { validateQuestion } = await import('./build.mjs');
  assert.deepEqual(validateQuestion(question, 'easy', 1), []);
});

await test('validateQuestion reports explicit field errors for malformed questions', async () => {
  const { validateQuestion } = await import('./build.mjs');
  const errors = validateQuestion({ ...question, id: 1.5, difficulty: 'hard', options: ['Only one'], answer: 4, sourceSlides: [14, '15'] }, 'easy', 1);
  for (const field of ['id', 'difficulty', 'options', 'answer', 'sourceSlides']) {
    assert.ok(errors.some(error => error.includes(field)), `missing ${field} error: ${errors.join('; ')}`);
  }
  const nullErrors = validateQuestion(null, 'easy', 1);
  assert.ok(nullErrors.length > 0);
});

await test('build CLI names the missing question-bank file', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'signal-build-'));
  try {
    mkdirSync(join(fixtureRoot, 'scripts'));
    mkdirSync(join(fixtureRoot, 'src', 'questions'), { recursive: true });
    copyFileSync(buildPath, join(fixtureRoot, 'scripts', 'build.mjs'));
    writeFileSync(join(fixtureRoot, 'src', 'template.html'), '{{EASY_QUESTIONS}}{{MEDIUM_QUESTIONS}}{{HARD_QUESTIONS}}');
    writeFileSync(join(fixtureRoot, 'src', 'questions', 'medium.json'), '[]');
    writeFileSync(join(fixtureRoot, 'src', 'questions', 'hard.json'), '[]');
    const result = spawnSync(process.execPath, [join(fixtureRoot, 'scripts', 'build.mjs')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /easy\.json/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

const loadBank = name => JSON.parse(readFileSync(join(projectRoot, 'src', 'questions', `${name}.json`), 'utf8'));
const easyBank = loadBank('easy');
const mediumBank = loadBank('medium');
const hardBank = loadBank('hard');
// Nine topics follow the handout's own structure (definitions, environments, ELO 1-6); weights follow how much content each has.
const CATEGORY_ORDER = ['Signal Support Concepts', 'Operational Environment', 'Roles of Signal Support', 'Systems and Technologies', 'Principles of Signal Support', 'Tactical Considerations', 'Signal Estimate and Requirements', 'Priorities, Continuity and Coordination', 'Security Measures and Protocols'];
const ALLOCATION = { 'Signal Support Concepts': 2, 'Operational Environment': 3, 'Roles of Signal Support': 3, 'Systems and Technologies': 3, 'Principles of Signal Support': 3, 'Tactical Considerations': 3, 'Signal Estimate and Requirements': 3, 'Priorities, Continuity and Coordination': 2, 'Security Measures and Protocols': 3 };
const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

for (const [name, bank] of [['easy', easyBank], ['medium', mediumBank], ['hard', hardBank]]) {
  await test(`${name} bank has 25 valid questions, sequential IDs, handout pages 1-19 and the required category allocation`, async () => {
    const { validateQuestion } = await import('./build.mjs');
    assert.equal(bank.length, 25);
    bank.forEach((item, index) => {
      assert.deepEqual(validateQuestion(item, name, index + 1), [], `${name} ${index + 1}`);
      assert.ok(item.tags.length > 0, `${name} ${index + 1} needs tags`);
      assert.equal(new Set(item.options.map(normalize)).size, 4, `${name} ${index + 1} needs four distinct options`);
    });
    const counts = {};
    for (const item of bank) counts[item.category] = (counts[item.category] ?? 0) + 1;
    assert.deepEqual(counts, ALLOCATION);
  });
  await test(`${name} answers are balanced (6 or 7 per letter) and the key is not usually the longest option`, () => {
    const counts = [0, 0, 0, 0];
    let longest = 0;
    for (const item of bank) {
      counts[item.answer]++;
      const lengths = item.options.map(option => option.length);
      if (lengths[item.answer] === Math.max(...lengths) && lengths.filter(l => l === lengths[item.answer]).length === 1) longest++;
    }
    assert.ok(counts.every(count => count === 6 || count === 7), counts.join('/'));
    assert.ok(longest <= 8, `key is the unique longest option in ${longest}/25 items`);
  });
}

function assertUniquePrompts(banks) {
  const seen = new Map();
  for (const [difficulty, bank] of Object.entries(banks)) {
    for (const item of bank) {
      const key = normalize(item.prompt);
      assert.ok(!seen.has(key), `Duplicate normalized prompt: ${seen.get(key)} and ${difficulty} ${item.id}`);
      seen.set(key, `${difficulty} ${item.id}`);
    }
  }
}

await test('All 75 prompts are unique across the three banks', () => {
  assertUniquePrompts({ easy: easyBank, medium: mediumBank, hard: hardBank });
});

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', middot: '·', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return String.fromCodePoint(value);
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
  }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return (this.element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  contains(name) { return this.values().includes(name); }
  add(...names) { this.element.setAttribute('class', [...new Set([...this.values(), ...names])].join(' ')); }
  remove(...names) { this.element.setAttribute('class', this.values().filter(name => !names.includes(name)).join(' ')); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

function reflectAttribute(name, attribute = name) {
  return {
    get() { return this.getAttribute(attribute) ?? ''; },
    set(value) { this.setAttribute(attribute, value); },
  };
}

function reflectBoolean(attribute) {
  return {
    get() { return this.hasAttribute(attribute); },
    set(value) { if (value) this.setAttribute(attribute, ''); else this.removeAttribute(attribute); },
  };
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.checkedState = null;
    this.classList = new FakeClassList(this);
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  get type() {
    return (this.getAttribute('type') ?? (this.localName === 'button' ? 'submit' : 'text')).toLowerCase();
  }
  set type(value) { this.setAttribute('type', value); }
  get checked() { return this.checkedState ?? this.hasAttribute('checked'); }
  set checked(value) { this.checkedState = Boolean(value); }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) {
    this.replaceChildren();
    if (String(value) !== '') this.appendChild(new FakeText(value));
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) throw new Error('removeChild: not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener.call(this, event);
    return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    const event = type => ({ type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    if (this.localName === 'input' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatchEvent(event('click'));
      this.dispatchEvent(event('input'));
      this.dispatchEvent(event('change'));
      return;
    }
    if (this.localName === 'input' && this.type === 'radio') {
      const wasChecked = this.checked;
      if (!wasChecked) {
        for (const other of findAll(this.ownerDocument.root, node => node.localName === 'input' && node.type === 'radio' && node.name === this.name)) {
          other.checked = false;
        }
        this.checked = true;
      }
      this.dispatchEvent(event('click'));
      if (!wasChecked) {
        this.dispatchEvent(event('input'));
        this.dispatchEvent(event('change'));
      }
      return;
    }
    this.dispatchEvent(event('click'));
  }
  focus() {
    // Mirror browsers: hidden or non-focusable elements silently ignore focus().
    if (!isShown(this)) return;
    const interactive = ['button', 'input', 'select', 'textarea'].includes(this.localName) && !this.disabled;
    if (!interactive && !this.hasAttribute('tabindex')) return;
    this.ownerDocument.activeElement = this;
  }
}

Object.defineProperties(FakeElement.prototype, {
  id: reflectAttribute('id'),
  className: reflectAttribute('className', 'class'),
  name: reflectAttribute('name'),
  value: reflectAttribute('value'),
  htmlFor: reflectAttribute('htmlFor', 'for'),
  hidden: reflectBoolean('hidden'),
  disabled: reflectBoolean('disabled'),
  tabIndex: {
    get() { return Number(this.getAttribute('tabindex') ?? 0); },
    set(value) { this.setAttribute('tabindex', value); },
  },
});

class FakeDocument {
  constructor() {
    this.root = new FakeElement('#document', this);
    this.activeElement = null;
  }
  get body() { return findAll(this.root, node => node.localName === 'body')[0] ?? null; }
  createElement(tagName) { return new FakeElement(tagName, this); }
  createTextNode(text) { return new FakeText(text); }
  getElementById(id) { return findAll(this.root, node => node.getAttribute('id') === id)[0] ?? null; }
}

function findAll(root, predicate) {
  const found = [];
  const visit = node => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (predicate(child)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function isShown(node) {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType === 1 && current.hasAttribute('hidden')) return false;
  }
  return true;
}

function parseHtml(html) {
  const document = new FakeDocument();
  const stack = [document.root];
  const tagPattern = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/gi;
  const attributePattern = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (match.index > cursor) stack.at(-1).appendChild(new FakeText(decodeEntities(html.slice(cursor, match.index))));
    cursor = tagPattern.lastIndex;
    const [whole, closingName, openingName, attributeText = '', selfClosing] = match;
    if (whole.startsWith('<!')) continue;
    if (closingName) {
      const name = closingName.toLowerCase();
      const index = stack.findLastIndex(node => node.localName === name);
      if (index > 0) stack.length = index;
      continue;
    }
    const element = document.createElement(openingName);
    for (const [, name, doubleQuoted, singleQuoted, bare] of attributeText.matchAll(attributePattern)) {
      element.setAttribute(name.toLowerCase(), decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? ''));
    }
    stack.at(-1).appendChild(element);
    if (RAW_TEXT_ELEMENTS.has(element.localName)) {
      const end = html.toLowerCase().indexOf(`</${element.localName}`, cursor);
      if (end === -1) throw new Error(`Unclosed <${element.localName}>`);
      element.appendChild(new FakeText(html.slice(cursor, end)));
      tagPattern.lastIndex = html.indexOf('>', end) + 1;
      cursor = tagPattern.lastIndex;
    } else if (!VOID_ELEMENTS.has(element.localName) && !selfClosing) {
      stack.push(element);
    }
  }
  if (cursor < html.length) stack.at(-1).appendChild(new FakeText(decodeEntities(html.slice(cursor))));
  return document;
}

const builtHtml = readFileSync(join(projectRoot, 'index.html'), 'utf8');

// The class history endpoint is the single configurable network address. Tests never reach it:
// by default they run with the endpoint cleared, and configured runs use a fake fetch.
const ENDPOINT_PATTERN = /var HISTORY_ENDPOINT = '([^']*)';/;
const TEST_ENDPOINT = 'https://script.google.com/macros/s/TEST-DEPLOYMENT/exec';
function withEndpoint(html, url) {
  assert.match(html, ENDPOINT_PATTERN, 'the app script must declare HISTORY_ENDPOINT');
  return html.replace(ENDPOINT_PATTERN, () => `var HISTORY_ENDPOINT = '${url}';`);
}
const baseHtml = withEndpoint(builtHtml, '');
const configuredHtml = withEndpoint(builtHtml, TEST_ENDPOINT);

// Records every request and answers through handler(call); a throwing handler is a network error.
function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: String(init.method ?? 'GET').toUpperCase(), headers: { ...(init.headers ?? {}) }, body: init.body };
    calls.push(call);
    const result = await handler(call);
    const status = result.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => result.body };
  };
  fetch.calls = calls;
  return fetch;
}
const okHistory = rows => ({ body: { ok: true, rows } });
const settle = app => app.api.whenSettled();

function appScripts(document) {
  return findAll(document.root, node => node.localName === 'script' && !/json/i.test(node.getAttribute('type') ?? ''));
}

function loadApp(html = baseHtml, { fetch } = {}) {
  const document = parseHtml(html);
  const printCalls = [];
  const consoleErrors = [];
  const sandbox = {
    document,
    console: { log() {}, info() {}, warn() {}, error: (...args) => consoleErrors.push(args.map(String).join(' ')) },
    print: () => printCalls.push(Date.now()),
  };
  if (fetch) sandbox.fetch = fetch;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const script of appScripts(document)) {
    vm.runInContext(script.textContent, sandbox, { filename: 'index.html' });
  }
  const api = sandbox.__signalQuiz;
  assert.ok(api, 'index.html must expose globalThis.__signalQuiz');
  return { document, api, printCalls, consoleErrors };
}

function byId(app, id) {
  const node = app.document.getElementById(id);
  assert.ok(node, `index.html must contain #${id}`);
  return node;
}

const plain = value => JSON.parse(JSON.stringify(value));
const HUB_URL = 'https://atticus-42.github.io/quiz-hub/#module-3';
const MODES = ['easy', 'medium', 'hard'];
const LETTERS = ['A', 'B', 'C', 'D'];
const sourceBanks = { easy: easyBank, medium: mediumBank, hard: hardBank };

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function attemptOf(app) {
  const { attempt } = plain(app.api.getState());
  assert.ok(attempt, 'an attempt must be active');
  return attempt;
}

function modeButtons(app) {
  return MODES.map(mode => byId(app, `mode-${mode}`));
}

function radios(app) {
  return findAll(byId(app, 'question-area'), node => node.localName === 'input' && node.type === 'radio');
}

const fireEvent = (node, type) => node.dispatchEvent({ type, target: node, defaultPrevented: false, preventDefault() {} });

// Types a name into the real field the way a browser does: value change, input event, then leaving the field.
function enterName(app, name) {
  const input = byId(app, 'student-name');
  input.value = name;
  fireEvent(input, 'input');
  fireEvent(input, 'blur');
}

function startConfirmed(app, mode = 'easy', name = 'Juan Dela Cruz') {
  enterName(app, name);
  byId(app, 'study-confirm').click();
  byId(app, `mode-${mode}`).click();
  assert.equal(plain(app.api.getState()).view, 'quiz', `${mode} must start after confirmation`);
}

// Answers every remaining question through the real controls; chooseCorrect(index) decides each answer.
function completeAttempt(app, chooseCorrect = () => true) {
  completeAttemptFrom(app, 0, chooseCorrect);
}

function completeAttemptFrom(app, start, chooseCorrect = () => true) {
  for (let index = start; index < 25; index++) {
    const attempt = attemptOf(app);
    assert.equal(attempt.current, index);
    const question = attempt.questions[index];
    const choice = chooseCorrect(index) ? question.answer : (question.answer + 1) % 4;
    radios(app)[choice].click();
    byId(app, 'btn-check').click();
    if (index < 24) byId(app, 'btn-next').click();
  }
}

function replaceBank(html, mode, content) {
  const pattern = new RegExp(`(<script type="application/json" id="questions-${mode}">)[\\s\\S]*?(</script>)`);
  assert.match(html, pattern);
  return html.replace(pattern, (_, open, close) => `${open}${content}${close}`);
}

await test('index.html is a fresh build of the template and banks', async () => {
  const { buildHtml } = await import('./build.mjs');
  const template = readFileSync(join(projectRoot, 'src', 'template.html'), 'utf8');
  assert.equal(builtHtml, buildHtml(template, sourceBanks), 'run node scripts/build.mjs before verifying');
});

await test('App exposes the quiz engine through globalThis.__signalQuiz', () => {
  const { api } = loadApp();
  for (const name of ['validateBanks', 'shuffleQuestions', 'createAttempt', 'setStudyConfirmed', 'startQuiz', 'selectAnswer', 'checkAnswer', 'goToQuestion', 'finishQuiz', 'retakeQuiz', 'resetToDifficulty', 'masteryBand', 'getState', 'getBanks', 'setRandom']) {
    assert.equal(typeof api[name], 'function', `${name} must be exposed`);
  }
  const state = plain(api.getState());
  assert.equal(state.available, true);
  assert.equal(state.view, 'landing');
});

await test('Study warning shows the exact confirmation text and all mode buttons start disabled', () => {
  const app = loadApp();
  const checkbox = byId(app, 'study-confirm');
  assert.equal(checkbox.localName, 'input');
  assert.equal(checkbox.type, 'checkbox');
  assert.equal(checkbox.checked, false);
  const label = findAll(app.document.root, node => node.localName === 'label' && (node.htmlFor === 'study-confirm' || node.children.includes(checkbox)))[0];
  assert.ok(label, 'the checkbox must have a label');
  assert.equal(label.textContent.replace(/\s+/g, ' ').trim(), 'I understand that I must study the complete lesson and not rely only on this mock examination.');
  assert.ok(isShown(byId(app, 'view-landing')));
  for (const button of modeButtons(app)) {
    assert.equal(button.localName, 'button');
    assert.equal(button.disabled, true, `${button.id} must start disabled`);
  }
});

await test('Mode buttons need both a valid name and the study confirmation; unchecking disables them again', () => {
  const app = loadApp();
  const checkbox = byId(app, 'study-confirm');
  byId(app, 'mode-easy').click();
  assert.equal(plain(app.api.getState()).view, 'landing', 'a disabled button must not start the quiz');
  assert.equal(app.api.startQuiz('easy'), false, 'startQuiz must refuse before confirmation');
  assert.equal(isShown(byId(app, 'view-quiz')), false);

  checkbox.click();
  assert.equal(plain(app.api.getState()).studyConfirmed, true);
  for (const button of modeButtons(app)) assert.equal(button.disabled, true, `${button.id} stays disabled without a name`);
  assert.equal(app.api.startQuiz('easy'), false, 'startQuiz must refuse without a name');
  assert.match(byId(app, 'mode-hint').textContent, /enter your name/i);
  enterName(app, 'Juan Dela Cruz');
  for (const button of modeButtons(app)) assert.equal(button.disabled, false, `${button.id} must enable`);

  checkbox.click();
  assert.equal(plain(app.api.getState()).studyConfirmed, false);
  for (const button of modeButtons(app)) assert.equal(button.disabled, true, `${button.id} must disable again`);
  assert.equal(app.api.startQuiz('medium'), false);

  app.api.setStudyConfirmed(true);
  assert.equal(checkbox.checked, true, 'setStudyConfirmed keeps the checkbox in sync');
  for (const button of modeButtons(app)) assert.equal(button.disabled, false);
  app.api.setStudyConfirmed(false);
  assert.equal(checkbox.checked, false);
  for (const button of modeButtons(app)) assert.equal(button.disabled, true);
});

await test('Each difficulty loads only its own 25 questions', () => {
  for (const mode of MODES) {
    const app = loadApp();
    startConfirmed(app, mode);
    const attempt = attemptOf(app);
    assert.equal(attempt.mode, mode);
    assert.equal(attempt.questions.length, 25);
    assert.ok(attempt.questions.every(item => item.difficulty === mode), `${mode} attempt mixed difficulties`);
    assert.deepEqual(attempt.questions.map(item => item.id).sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index + 1));
    assert.deepEqual(new Set(attempt.questions.map(item => item.prompt)), new Set(sourceBanks[mode].map(item => item.prompt)));
    assert.deepEqual(attempt.questions, attempt.questions.map(item => sourceBanks[mode].find(source => source.id === item.id)), 'authored question and choice order must be preserved');
    assert.equal(byId(app, 'question-prompt').textContent, attempt.questions[0].prompt);
  }
});

await test('Starting a quiz renders the first question as a fieldset with four radio choices and moves focus to it', () => {
  const app = loadApp();
  startConfirmed(app, 'hard');
  const attempt = attemptOf(app);
  assert.ok(isShown(byId(app, 'view-quiz')));
  assert.equal(isShown(byId(app, 'view-landing')), false);
  assert.equal(app.document.activeElement?.id, 'question-heading');
  assert.match(byId(app, 'question-heading').textContent, /Question 1 of 25/);
  const legend = byId(app, 'question-prompt');
  assert.equal(legend.localName, 'legend');
  assert.equal(legend.parentNode.localName, 'fieldset');
  const choices = radios(app);
  assert.equal(choices.length, 4);
  assert.equal(new Set(choices.map(choice => choice.name)).size, 1);
  choices.forEach((choice, index) => {
    const label = findAll(app.document.root, node => node.localName === 'label' && (node.htmlFor === choice.id || node.children.includes(choice)))[0];
    assert.ok(label, `choice ${index} must be labelled`);
    assert.ok(label.textContent.includes(attempt.questions[0].options[index]));
    assert.ok(label.textContent.includes(`${LETTERS[index]}.`));
  });
  const status = byId(app, 'quiz-status');
  assert.ok(status.getAttribute('role') === 'status' || status.getAttribute('aria-live'), 'quiz status must be a live region');
  assert.equal(byId(app, 'quiz-progress').localName, 'progress');
});

await test('Fisher-Yates shuffle matches a hand-checked order and copies the source', () => {
  const { api } = loadApp();
  const source = ['a', 'b', 'c', 'd', 'e'];
  const draws = [0.1, 0.9, 0.5, 0.0];
  // i=4: j=floor(0.1*5)=0 -> e b c d a; i=3: j=floor(0.9*4)=3 -> unchanged;
  // i=2: j=floor(0.5*3)=1 -> e c b d a; i=1: j=floor(0.0*2)=0 -> c e b d a
  const shuffled = api.shuffleQuestions(source, () => draws.shift());
  assert.deepEqual(plain(shuffled), ['c', 'e', 'b', 'd', 'a']);
  assert.deepEqual(source, ['a', 'b', 'c', 'd', 'e'], 'source must not be mutated');
  assert.notEqual(shuffled, source);
  assert.equal(draws.length, 0, 'exactly n-1 random draws');
  const defaultShuffle = plain(api.shuffleQuestions(source));
  assert.deepEqual([...defaultShuffle].sort(), source);

  const attempt = plain(api.createAttempt('medium', sourceBanks, seededRandom(3)));
  assert.equal(attempt.mode, 'medium');
  assert.deepEqual(attempt.questions, plain(api.shuffleQuestions(mediumBank, seededRandom(3))));
  assert.equal(attempt.current, 0);
  assert.ok(attempt.responses.length === 25 && attempt.responses.every(response => response.selected === null && response.checked === false));
});

await test('Source banks stay unchanged while three retakes each reshuffle the same difficulty', () => {
  const app = loadApp();
  const snapshot = JSON.stringify(app.api.getBanks());
  assert.equal(snapshot, JSON.stringify(sourceBanks));
  app.api.setRandom(seededRandom(7));
  startConfirmed(app, 'medium');
  let previousOrder = attemptOf(app).questions.map(item => item.id);
  for (let retake = 1; retake <= 3; retake++) {
    completeAttempt(app);
    byId(app, 'btn-finish').click();
    assert.equal(plain(app.api.getState()).view, 'results');
    byId(app, 'btn-retake').click();
    const attempt = attemptOf(app);
    assert.equal(attempt.mode, 'medium', `retake ${retake} keeps the difficulty`);
    assert.ok(attempt.responses.every(response => response.selected === null && !response.checked), `retake ${retake} starts clean`);
    const order = attempt.questions.map(item => item.id);
    assert.notDeepEqual(order, previousOrder, `retake ${retake} must reshuffle`);
    assert.equal(JSON.stringify(app.api.getBanks()), snapshot, `source banks changed after retake ${retake}`);
    assert.equal(app.document.activeElement?.id, 'question-heading');
    previousOrder = order;
  }
});

await test('Question order and recorded answers stay stable during navigation', () => {
  const app = loadApp();
  startConfirmed(app, 'easy');
  const order = attemptOf(app).questions.map(item => item.id);
  for (let index = 0; index < 5; index++) {
    radios(app)[index % 4].click();
    byId(app, 'btn-check').click();
    byId(app, 'btn-next').click();
  }
  assert.equal(attemptOf(app).current, 5);
  assert.equal(app.api.goToQuestion(7), false, 'cannot skip past the first unchecked question');
  assert.equal(app.api.goToQuestion(-1), false);
  assert.equal(app.api.goToQuestion(1), true);
  assert.equal(app.document.activeElement?.id, 'question-heading');
  assert.equal(radios(app)[1].checked, true, 'recorded answer shows on revisit');
  assert.ok(radios(app).every(choice => choice.disabled), 'revisited checked question stays locked');
  assert.ok(isShown(byId(app, 'answer-feedback')), 'feedback stays reviewable');
  byId(app, 'btn-prev').click();
  assert.equal(attemptOf(app).current, 0);
  assert.equal(isShown(byId(app, 'btn-prev')), false, 'no previous button on question 1');
  assert.equal(app.api.goToQuestion(5), true);
  const attempt = attemptOf(app);
  assert.deepEqual(attempt.questions.map(item => item.id), order);
  assert.deepEqual(attempt.responses.slice(0, 5).map(response => [response.selected, response.checked]), [[0, true], [1, true], [2, true], [3, true], [0, true]]);
  assert.deepEqual([attempt.responses[5].selected, attempt.responses[5].checked], [null, false]);
});

await test('Check answer with no selection shows a validation message and does not advance', () => {
  const app = loadApp();
  startConfirmed(app, 'easy');
  const validation = byId(app, 'validation-message');
  assert.equal(isShown(validation), false);
  byId(app, 'btn-check').click();
  assert.equal(app.api.checkAnswer(), false);
  const attempt = attemptOf(app);
  assert.equal(attempt.current, 0);
  assert.equal(attempt.responses[0].checked, false);
  assert.ok(isShown(validation));
  assert.match(validation.textContent, /select an answer/i);
  assert.ok(validation.getAttribute('role') === 'alert' || validation.getAttribute('aria-live'));
  assert.equal(app.document.activeElement?.id, 'validation-message');
  assert.equal(isShown(byId(app, 'btn-next')), false);
  assert.equal(isShown(byId(app, 'answer-feedback')), false);
  radios(app)[2].click();
  assert.equal(isShown(validation), false, 'selecting clears the validation message');
});

await test('Checked answers lock and cannot be changed', () => {
  const app = loadApp();
  startConfirmed(app, 'hard');
  const question = attemptOf(app).questions[0];
  const wrong = (question.answer + 1) % 4;
  radios(app)[wrong].click();
  assert.equal(app.api.checkAnswer(), true);
  assert.equal(app.api.selectAnswer(question.answer), false);
  radios(app)[question.answer].click();
  assert.equal(app.api.checkAnswer(), false, 'a checked answer cannot be checked again');
  const response = attemptOf(app).responses[0];
  assert.deepEqual([response.selected, response.checked], [wrong, true]);
  assert.ok(radios(app).every(choice => choice.disabled));
  assert.equal(radios(app)[wrong].checked, true);
  assert.equal(isShown(byId(app, 'btn-check')), false);
});

await test('Checking reveals the correct answer and explanation and focuses the feedback', () => {
  const app = loadApp();
  startConfirmed(app, 'easy');
  const [first, second] = attemptOf(app).questions;
  const wrong = (first.answer + 3) % 4;
  radios(app)[wrong].click();
  byId(app, 'btn-check').click();
  const feedback = byId(app, 'answer-feedback');
  assert.ok(isShown(feedback));
  assert.equal(app.document.activeElement?.id, 'answer-feedback');
  const text = feedback.textContent;
  assert.match(text, /Incorrect/);
  assert.ok(text.includes(`Correct answer: ${LETTERS[first.answer]}. ${first.options[first.answer]}`), text);
  assert.ok(text.includes(`Your answer: ${LETTERS[wrong]}. ${first.options[wrong]}`), text);
  assert.ok(text.includes(first.explanation));
  const labels = findAll(byId(app, 'question-area'), node => node.localName === 'label');
  assert.ok(labels[first.answer].classList.contains('option-correct'));
  assert.ok(labels[wrong].classList.contains('option-incorrect'));
  assert.match(labels[first.answer].textContent, /Correct answer/, 'correctness is not conveyed by color alone');
  assert.equal(plain(app.api.getState()).attempt.current, 0, 'checking does not advance by itself');

  byId(app, 'btn-next').click();
  radios(app)[second.answer].click();
  byId(app, 'btn-check').click();
  assert.match(byId(app, 'answer-feedback').textContent, /^\s*Correct\./);
  assert.ok(byId(app, 'answer-feedback').textContent.includes(second.explanation));
});

await test('validateBanks accepts the embedded banks and mirrors the build validator error-for-error', async () => {
  const { validateQuestion } = await import('./build.mjs');
  const { api } = loadApp();
  assert.deepEqual(plain(api.validateBanks(sourceBanks)), { valid: true, errors: [] });
  const base = easyBank[0];
  const mutations = [
    { ...base, id: 1.5 },
    { ...base, difficulty: 'hard' },
    { ...base, options: base.options.slice(0, 3) },
    { ...base, answer: 4 },
    { ...base, sourceSlides: [20] },
    { ...base, sourceSlides: [0] },
    { ...base, sourceSlides: [] },
    { ...base, tags: [''] },
    { ...base, prompt: '  ' },
    { ...base, category: 7 },
    { ...base, explanation: undefined },
    null,
    [],
  ];
  for (const mutated of mutations) {
    const result = plain(api.validateBanks({ ...sourceBanks, easy: [mutated, ...easyBank.slice(1)] }));
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, validateQuestion(mutated, 'easy', 1).map(error => `easy question 1: ${error}`));
  }
  const short = plain(api.validateBanks({ ...sourceBanks, medium: mediumBank.slice(0, 24) }));
  assert.equal(short.valid, false);
  assert.ok(short.errors.some(error => /medium/.test(error) && /25/.test(error)), short.errors.join('; '));
  const missing = plain(api.validateBanks({ easy: easyBank, medium: mediumBank }));
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(error => /hard/.test(error)), missing.errors.join('; '));
});

await test('Malformed or missing startup data shows the unavailable state and blocks every quiz start', () => {
  const brokenAnswer = plain(hardBank);
  brokenAnswer[3].answer = 4;
  const variants = {
    'unparseable Easy JSON': replaceBank(baseHtml, 'easy', '{not json'),
    'Medium bank with 24 items': replaceBank(baseHtml, 'medium', JSON.stringify(mediumBank.slice(0, 24))),
    'Hard answer index out of range': replaceBank(baseHtml, 'hard', JSON.stringify(brokenAnswer)),
    'missing Easy bank element': baseHtml.replace(/<script type="application\/json" id="questions-easy">[\s\S]*?<\/script>/, ''),
  };
  for (const [name, html] of Object.entries(variants)) {
    const app = loadApp(html);
    const state = plain(app.api.getState());
    assert.equal(state.available, false, name);
    assert.ok(state.errors.length > 0, `${name}: errors must be recorded`);
    assert.ok(isShown(byId(app, 'view-unavailable')), `${name}: unavailable view must show`);
    assert.match(byId(app, 'view-unavailable').textContent, /unavailable/i);
    assert.equal(isShown(byId(app, 'view-landing')), false, `${name}: landing must hide`);
    assert.equal(app.document.activeElement?.id, 'unavailable-heading', `${name}: focus must move to the unavailable heading`);
    assert.equal(byId(app, 'study-confirm').disabled, true, name);
    assert.equal(byId(app, 'student-name').disabled, true, `${name}: the name field is disabled too`);
    assert.equal(app.api.setStudentName('Juan Dela Cruz'), false, name);
    app.api.setStudyConfirmed(true);
    byId(app, 'study-confirm').click();
    for (const button of modeButtons(app)) assert.equal(button.disabled, true, `${name}: ${button.id}`);
    for (const mode of MODES) assert.equal(app.api.startQuiz(mode), false, `${name}: ${mode}`);
    assert.equal(isShown(byId(app, 'view-quiz')), false, name);
    assert.equal(plain(app.api.getState()).attempt, null, name);
  }
  assert.equal(isShown(byId(loadApp(), 'view-unavailable')), false, 'valid data must not show the unavailable state');
});

await test('Mastery bands use the documented 90/75/60 thresholds', () => {
  const { api } = loadApp();
  const cases = [[100, 'Mastery'], [90, 'Mastery'], [89, 'Proficient'], [75, 'Proficient'], [74, 'Developing'], [60, 'Developing'], [59, 'Needs review'], [0, 'Needs review']];
  for (const [percentage, band] of cases) assert.equal(api.masteryBand(percentage).name, band, `${percentage}%`);
});

await test('All 25 checked answers produce scored results with topic analysis, full review and actions', () => {
  const app = loadApp();
  startConfirmed(app, 'easy');
  assert.equal(app.api.finishQuiz(), false, 'results are unavailable before every item is checked');
  assert.equal(isShown(byId(app, 'view-results')), false);
  const wrongIndexes = new Set([0, 5, 10, 15, 20]);
  completeAttempt(app, index => !wrongIndexes.has(index));
  const attempt = attemptOf(app);
  assert.ok(isShown(byId(app, 'btn-finish')));
  byId(app, 'btn-finish').click();

  assert.ok(isShown(byId(app, 'view-results')));
  assert.equal(isShown(byId(app, 'view-quiz')), false);
  assert.equal(app.document.activeElement?.id, 'results-heading');
  const summary = byId(app, 'results-summary').textContent;
  assert.match(summary, /20 of 25/);
  assert.match(summary, /80%/);
  assert.match(summary, /Proficient/);

  const expected = new Map();
  attempt.questions.forEach((item, index) => {
    const entry = expected.get(item.category) ?? { correct: 0, total: 0 };
    entry.total++;
    if (!wrongIndexes.has(index)) entry.correct++;
    expected.set(item.category, entry);
  });
  const rows = findAll(byId(app, 'results-categories-body'), node => node.localName === 'tr');
  assert.equal(rows.length, expected.size);
  for (const row of rows) {
    const [category, count, status] = row.children.map(cell => cell.textContent.trim());
    const entry = expected.get(category);
    assert.ok(entry, `unexpected category row ${category}`);
    assert.ok(count.startsWith(`${entry.correct} of ${entry.total}`), `${category}: ${count}`);
    assert.equal(status, entry.correct / entry.total >= 0.75 ? 'Strength' : 'Gap');
  }
  const strengths = findAll(byId(app, 'results-strengths'), node => node.localName === 'li').map(node => node.textContent);
  const gaps = findAll(byId(app, 'results-gaps'), node => node.localName === 'li').map(node => node.textContent);
  for (const [category, entry] of expected) {
    const list = entry.correct / entry.total >= 0.75 ? strengths : gaps;
    assert.equal(list.filter(text => text.includes(category)).length, 1, `${category} must be listed once in the right list`);
  }

  const reviewItems = byId(app, 'results-review').children;
  assert.equal(reviewItems.length, 25);
  reviewItems.forEach((item, index) => {
    const question = attempt.questions[index];
    const selected = attempt.responses[index].selected;
    const text = item.textContent;
    assert.ok(text.includes(question.prompt), `review ${index + 1} prompt`);
    assert.ok(text.includes(`Your answer: ${LETTERS[selected]}. ${question.options[selected]}`), `review ${index + 1} answer`);
    assert.ok(text.includes(`Correct answer: ${LETTERS[question.answer]}. ${question.options[question.answer]}`), `review ${index + 1} key`);
    assert.ok(text.includes(question.explanation), `review ${index + 1} explanation`);
    assert.match(text, wrongIndexes.has(index) ? /Incorrect/ : /Correct/);
  });

  byId(app, 'btn-print').click();
  assert.equal(app.printCalls.length, 1, 'print/save calls window.print');
  byId(app, 'btn-choose').click();
  assert.ok(isShown(byId(app, 'view-landing')));
  assert.equal(isShown(byId(app, 'view-results')), false);
  assert.equal(plain(app.api.getState()).attempt, null);
  assert.equal(app.document.activeElement?.id, 'difficulty-heading');
  for (const button of modeButtons(app)) assert.equal(button.disabled, false, 'confirmation carries over to difficulty choice');
  byId(app, 'mode-hard').click();
  assert.equal(attemptOf(app).mode, 'hard');
});

await test('App keeps answers in memory only: its one network call goes to HISTORY_ENDPOINT, with no storage, cookies or HTML parsing', () => {
  const document = parseHtml(builtHtml);
  const code = appScripts(document).map(script => script.textContent).join('\n');
  assert.ok(code.length > 0, 'index.html must contain the app script');
  assert.equal(code.match(/\bfetch\s*\(/g)?.length, 1, 'exactly one fetch call site');
  assert.match(code, /function historyRequest\(url, init\) \{\s*if \(!ENDPOINT \|\| url\.indexOf\(ENDPOINT\) !== 0\) return Promise\.reject/, 'the fetch wrapper must refuse any URL outside HISTORY_ENDPOINT');
  assert.doesNotMatch(code, /XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie|serviceWorker|\bimport\s*\(|new Audio\b/);
  assert.doesNotMatch(code, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, 'remote strings must never be parsed as HTML');
  assert.equal(builtHtml.split('var HISTORY_ENDPOINT =').length - 1, 1, 'HISTORY_ENDPOINT is declared exactly once');
  const endpoint = builtHtml.match(ENDPOINT_PATTERN)[1];
  assert.ok(endpoint === '' || /^https:\/\/[^\s'"<>\\]+$/.test(endpoint), 'HISTORY_ENDPOINT must be empty or an https URL');
  const withoutAssetImages = builtHtml.replace(/<(?:img|source)\b[^>]*>/gi, (tag) => (/\b(?:src|srcset)="(?:assets\/[\w-]+\.jpg(?: [\w.]+)?(?:, )?)+"/.test(tag) && !/\/\/|https?:/i.test(tag) ? '' : tag));
  assert.doesNotMatch(withoutAssetImages, /<link\b|<img\b|<source\b|<iframe\b|<audio\b|\bsrc\s*=|\bsrcset\s*=|@import|url\(\s*['"]?(?:https?:)?\/\//i, 'only relative assets/ images are allowed');
  assert.doesNotMatch(builtHtml, /\.(?:mp3|wav|ogg|m4a)\b/i, 'sounds are synthesised, never loaded');
});

await test('Names are trimmed, 2-40 characters, need a letter or number, and invalid names are rejected with a visible message', () => {
  const { api } = loadApp();
  const valid = (raw, name) => {
    const result = plain(api.validateName(raw));
    assert.equal(result.valid, true, `${JSON.stringify(raw)} should be valid: ${result.message}`);
    assert.equal(result.name, name);
  };
  const invalid = (raw, pattern) => {
    const result = plain(api.validateName(raw));
    assert.equal(result.valid, false, `${JSON.stringify(raw)} should be rejected`);
    assert.equal(result.name, '');
    assert.match(result.message, pattern);
  };
  valid('  Ana  ', 'Ana');
  valid('Pvt.  Juan\tDela Cruz', 'Pvt. Juan Dela Cruz');
  valid('A\u0000B', 'A B');
  valid('x'.repeat(40), 'x'.repeat(40));
  valid('=Cruz', 'Cruz');
  valid('Ñiño', 'Ñiño');
  invalid('', /enter your name/i);
  invalid('   ', /enter your name/i);
  invalid('J', /at least 2/);
  invalid(' J\u0007 ', /at least 2/);
  invalid('x'.repeat(41), /40 characters or fewer/);
  invalid('...', /letter or number/);
  invalid(null, /enter your name/i);

  const app = loadApp();
  const input = byId(app, 'student-name');
  const label = findAll(app.document.root, node => node.localName === 'label' && node.htmlFor === 'student-name')[0];
  assert.ok(label && /name/i.test(label.textContent), 'the name field has a visible label');
  const message = byId(app, 'student-name-message');
  assert.equal(isShown(message), false, 'no error before the student types');
  byId(app, 'study-confirm').click();
  enterName(app, 'J');
  assert.ok(isShown(message));
  assert.match(message.textContent, /at least 2/);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.ok((input.getAttribute('aria-describedby') ?? '').includes('student-name-message'));
  for (const button of modeButtons(app)) assert.equal(button.disabled, true, 'invalid names keep the modes locked');
  assert.equal(app.api.startQuiz('easy'), false);
  enterName(app, '   ');
  assert.match(message.textContent, /enter your name/i, 'leaving the field empty explains what is needed');
  enterName(app, '  Maria Santos ');
  assert.equal(isShown(message), false);
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  for (const button of modeButtons(app)) assert.equal(button.disabled, false);
  assert.equal(plain(app.api.getState()).studentName, 'Maria Santos');
  byId(app, 'mode-medium').click();
  assert.match(byId(app, 'quiz-student').textContent, /Maria Santos/, 'the name shows on the quiz screen');
  completeAttempt(app);
  byId(app, 'btn-finish').click();
  assert.match(byId(app, 'results-summary').textContent, /Maria Santos/, 'the name shows on the results screen');
});

await test('Finishing an attempt submits exactly one history record with the attempt summary and never the answers', async () => {
  const fetch = fakeFetch(call => (call.method === 'POST' ? { body: { ok: true } } : okHistory([])));
  const app = loadApp(configuredHtml, { fetch });
  await settle(app);
  startConfirmed(app, 'easy', 'Maria Santos');
  const wrongIndexes = new Set([0, 5, 10, 15, 20]);
  completeAttempt(app, index => !wrongIndexes.has(index));
  assert.equal(fetch.calls.filter(call => call.method === 'POST').length, 0, 'nothing is sent before the attempt finishes');
  const before = Date.now();
  byId(app, 'btn-finish').click();
  assert.ok(isShown(byId(app, 'view-results')), 'results show without waiting for the network');
  await settle(app);
  const posts = fetch.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1, 'one submission per finished attempt');
  const [post] = posts;
  assert.equal(post.url, TEST_ENDPOINT);
  assert.equal(post.headers['Content-Type'], 'text/plain;charset=utf-8', 'text/plain avoids a CORS preflight');
  const payload = JSON.parse(post.body);
  assert.deepEqual(Object.keys(payload).sort(), ['band', 'finishedAt', 'lesson', 'mode', 'name', 'percent', 'score', 'total']);
  assert.deepEqual({ ...payload, finishedAt: undefined }, { lesson: 'signal', name: 'Maria Santos', mode: 'easy', score: 20, total: 25, percent: 80, band: 'Proficient', finishedAt: undefined });
  assert.match(payload.finishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(payload.finishedAt) >= before - 1000 && Date.parse(payload.finishedAt) <= Date.now() + 1000);
  for (const call of fetch.calls) {
    assert.ok(call.url.startsWith(TEST_ENDPOINT), `request to ${call.url} is outside HISTORY_ENDPOINT`);
    assert.ok(!call.url.includes('Maria'), 'names never travel in URLs');
  }
  const gets = fetch.calls.filter(call => call.method === 'GET');
  assert.ok(gets.length >= 2, 'history loads at start and refreshes after saving');
  assert.equal(gets[0].url, `${TEST_ENDPOINT}?lesson=signal&mode=all&limit=100`);
  assert.match(byId(app, 'history-save-message').textContent, /Saved to the class history/);
  assert.equal(isShown(byId(app, 'btn-history-retry')), false);
  byId(app, 'btn-retake').click();
  completeAttempt(app);
  byId(app, 'btn-finish').click();
  await settle(app);
  assert.equal(fetch.calls.filter(call => call.method === 'POST').length, 2, 'a retake is a new attempt with its own record');
});

await test('Not-configured history shows the setup message and never calls fetch', async () => {
  const fetch = fakeFetch(() => { throw new Error('fetch must not be called'); });
  const app = loadApp(baseHtml, { fetch });
  await settle(app);
  assert.equal(plain(app.api.getState()).historyConfigured, false);
  assert.ok(isShown(byId(app, 'history-panel')), 'the history section is on the landing view');
  const status = byId(app, 'history-status').textContent;
  assert.match(status, /not set up/i);
  assert.match(status, /apps-script\/SETUP\.md/);
  assert.equal(isShown(byId(app, 'history-table-wrap')), false);
  assert.ok(MODES.every(mode => byId(app, `history-filter-${mode}`).disabled));
  startConfirmed(app, 'hard');
  completeAttempt(app);
  byId(app, 'btn-finish').click();
  await settle(app);
  assert.ok(isShown(byId(app, 'view-results')));
  assert.match(byId(app, 'history-save-message').textContent, /not set up/i);
  assert.equal(isShown(byId(app, 'btn-history-retry')), false);
  byId(app, 'btn-history').click();
  assert.equal(app.document.activeElement?.id, 'history-heading', 'the results button jumps to the history section');
  byId(app, 'btn-choose').click();
  await settle(app);
  assert.equal(fetch.calls.length, 0, 'no network access without an endpoint');
});

await test('A failed history save still shows the results and offers a retry that resends the same record', async () => {
  const outcomes = [() => { throw new Error('offline'); }, () => ({ body: { ok: false, error: 'invalid score' } }), () => ({ status: 500, body: {} }), () => ({ body: { ok: true } })];
  const fetch = fakeFetch(call => (call.method === 'POST' ? outcomes.shift()() : okHistory([])));
  const app = loadApp(configuredHtml, { fetch });
  startConfirmed(app, 'medium');
  completeAttempt(app);
  byId(app, 'btn-finish').click();
  await settle(app);
  assert.ok(isShown(byId(app, 'view-results')), 'results stay visible');
  assert.equal(app.document.activeElement?.id, 'results-heading');
  assert.match(byId(app, 'results-summary').textContent, /25 of 25/);
  const message = byId(app, 'history-save-message');
  const retry = byId(app, 'btn-history-retry');
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.match(message.textContent, /could not save to class history/i, `failure ${attempt}`);
    assert.ok(isShown(retry), 'a retry button is offered');
    retry.click();
    await settle(app);
  }
  assert.match(message.textContent, /could not save to class history/i, 'HTTP errors count as failures');
  retry.click();
  await settle(app);
  assert.match(message.textContent, /Saved to the class history/);
  assert.equal(isShown(retry), false);
  const bodies = fetch.calls.filter(call => call.method === 'POST').map(call => call.body);
  assert.equal(bodies.length, 4);
  assert.equal(new Set(bodies).size, 1, 'retries resend the identical record');
});

await test('Class history renders remote rows as text, newest first, marks the current student and filters by mode', async () => {
  const hostile = '<img src=x onerror=alert(1)></td><script>alert(2)</script>';
  const rows = [
    { name: 'Old Timer', mode: 'easy', score: 10, total: 25, percent: 40, band: 'Needs review', finishedAt: '2026-09-01T08:00:00.000Z' },
    { name: hostile, mode: 'medium', score: 18, total: 25, percent: 72, band: '<b>Developing</b>', finishedAt: '2026-09-29T08:00:00.000Z' },
    { name: 'Maria Santos', mode: 'hard', score: 23, total: 25, percent: 92, band: 'Mastery', finishedAt: '2026-09-30T08:00:00.000Z' },
    { name: 'maria santos', mode: 'medium', score: 20, total: 25, percent: 80, band: 'Proficient', finishedAt: '2026-09-15T08:00:00.000Z' },
    { name: 'Bogus Mode', mode: 'expert', score: 1, total: 25, percent: 4, band: 'x', finishedAt: '2026-09-30T09:00:00.000Z' },
    'not a row',
  ];
  let mode = 'all';
  let fail = false;
  const fetch = fakeFetch(call => {
    if (fail) throw new Error('offline');
    mode = new URL(call.url).searchParams.get('mode');
    return okHistory(mode === 'hard' ? [] : rows);
  });
  const app = loadApp(configuredHtml, { fetch });
  enterName(app, 'MARIA SANTOS');
  await settle(app);
  const body = byId(app, 'history-body');
  const rendered = () => body.children.map(row => row.children.map(cell => cell.textContent.trim()));
  assert.ok(isShown(byId(app, 'history-table-wrap')));
  const headers = findAll(byId(app, 'history-table'), node => node.localName === 'th').map(node => node.textContent.trim());
  assert.deepEqual(headers, ['Name', 'Mode', 'Score', '%', 'Band', 'Date']);
  assert.deepEqual(rendered().map(cells => cells[0]), ['Maria Santos You', hostile, 'maria santos You', 'Old Timer'], 'newest first; invalid rows dropped');
  assert.deepEqual(rendered()[0].slice(1, 5), ['Hard', '23/25', '92%', 'Mastery']);
  assert.match(rendered()[0][5], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(findAll(body, node => ['img', 'script', 'b'].includes(node.localName)).length, 0, 'remote markup is never parsed');
  const hostileText = findAll(body, node => /\bhistory-name-text\b/.test(node.getAttribute('class') ?? '')).map(node => node.textContent);
  assert.ok(hostileText.includes(hostile), 'the hostile name is shown literally');
  assert.equal(rendered()[1][4], '<b>Developing</b>');
  const selfRows = body.children.filter(row => row.classList.contains('history-row-self'));
  assert.equal(selfRows.length, 2, 'the current student rows are highlighted case-insensitively');
  assert.ok(selfRows.every(row => findAll(row, node => /\btag-you\b/.test(node.getAttribute('class') ?? '') && node.textContent === 'You').length === 1), 'highlighting is not colour alone');
  assert.equal(byId(app, 'history-filter-all').getAttribute('aria-pressed'), 'true');

  byId(app, 'history-filter-medium').click();
  await settle(app);
  assert.equal(mode, 'medium', 'the filter is sent to the sheet');
  assert.equal(fetch.calls.at(-1).url, `${TEST_ENDPOINT}?lesson=signal&mode=medium&limit=100`);
  assert.deepEqual(rendered().map(cells => cells[1]), ['Medium', 'Medium'], 'only Medium rows are shown');
  assert.equal(byId(app, 'history-filter-medium').getAttribute('aria-pressed'), 'true');
  assert.equal(byId(app, 'history-filter-all').getAttribute('aria-pressed'), 'false');
  assert.match(byId(app, 'history-status').textContent, /2 most recent Medium attempts/);

  byId(app, 'history-filter-hard').click();
  await settle(app);
  assert.equal(isShown(byId(app, 'history-table-wrap')), false);
  assert.match(byId(app, 'history-status').textContent, /No Hard attempts have been recorded yet/);

  fail = true;
  byId(app, 'btn-history-refresh').click();
  assert.match(byId(app, 'history-status').textContent, /Loading/);
  await settle(app);
  assert.match(byId(app, 'history-status').textContent, /Could not load the class history/);
  assert.equal(isShown(byId(app, 'history-table-wrap')), false);
});

await test('Class history payload is accepted by apps-script/Code.gs and round-trips through doGet', async () => {
  const source = readFileSync(join(projectRoot, 'apps-script', 'Code.gs'), 'utf8');
  const sheetRows = [];
  const sheet = {
    getLastRow: () => sheetRows.length,
    appendRow: row => { sheetRows.push(row); },
    setFrozenRows() {},
    getDataRange: () => ({ getValues: () => sheetRows.map(row => [...row]) }),
  };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => (sheetRows.length ? sheet : null), insertSheet: () => sheet }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  const call = (fn, arg) => JSON.parse(context[fn](arg).text);

  const fetch = fakeFetch(request => (request.method === 'POST' ? { body: call('doPost', { postData: { contents: request.body } }) } : okHistory([])));
  const app = loadApp(configuredHtml, { fetch });
  startConfirmed(app, 'hard', 'Sgt. Reyes');
  completeAttempt(app, index => index % 5 !== 0);
  byId(app, 'btn-finish').click();
  await settle(app);
  assert.match(byId(app, 'history-save-message').textContent, /Saved/, 'the sheet accepted the client payload');
  const reply = call('doGet', { parameter: { mode: 'hard', limit: '5' } });
  assert.equal(reply.ok, true);
  assert.equal(reply.rows.length, 1);
  assert.deepEqual({ ...reply.rows[0], finishedAt: undefined }, { name: 'Sgt. Reyes', mode: 'hard', score: 20, total: 25, percent: 80, band: 'Proficient', finishedAt: undefined });
  assert.equal(call('doGet', { parameter: { mode: 'easy' } }).rows.length, 0);
});

await test('Sound effects: a visible toggle (on by default) and cues for select, correct, incorrect, start, error and finish', () => {
  const app = loadApp();
  const cues = [];
  app.api.setSoundPlayer(cue => cues.push(cue));
  const toggle = byId(app, 'btn-sound');
  assert.equal(toggle.localName, 'button');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'sound is on by default');
  assert.match(toggle.textContent, /Sound effects/);
  assert.match(byId(app, 'sound-state').textContent, /On/);
  assert.equal(plain(app.api.getState()).soundEnabled, true);

  startConfirmed(app, 'easy');
  assert.deepEqual(cues, ['start']);
  const [first, second, third] = attemptOf(app).questions;
  byId(app, 'btn-check').click();
  assert.equal(cues.at(-1), 'error', 'a validation error has a soft cue');
  radios(app)[(first.answer + 1) % 4].click();
  assert.equal(cues.at(-1), 'select');
  byId(app, 'btn-check').click();
  assert.equal(cues.at(-1), 'incorrect');
  byId(app, 'btn-next').click();
  radios(app)[second.answer].click();
  byId(app, 'btn-check').click();
  assert.equal(cues.at(-1), 'correct');

  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.match(byId(app, 'sound-state').textContent, /Off/);
  assert.equal(plain(app.api.getState()).soundEnabled, false);
  const muted = cues.length;
  byId(app, 'btn-next').click();
  radios(app)[third.answer].click();
  byId(app, 'btn-check').click();
  assert.equal(cues.length, muted, 'no cue plays while sound is off');
  assert.match(byId(app, 'answer-feedback').textContent, /^\s*Correct\./, 'visual feedback does not depend on sound');

  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  byId(app, 'btn-next').click();
  completeAttemptFrom(app, 3);
  byId(app, 'btn-finish').click();
  assert.equal(cues.at(-1), 'finish-mastery', 'the finish cue follows the mastery band');

  app.api.setSoundPlayer(() => { throw new Error('audio device lost'); });
  byId(app, 'btn-retake').click();
  assert.equal(plain(app.api.getState()).view, 'quiz', 'a failing audio stack never blocks the quiz');
  app.api.setSoundPlayer(null);
  assert.equal(app.api.selectAnswer(0), true, 'the default Web Audio player is a no-op without AudioContext');
});

await test('App script avoids the Safari 14+ replaceChildren API', () => {
  const code = appScripts(parseHtml(builtHtml)).map(script => script.textContent).join('\n');
  assert.ok(!/\breplaceChildren\b/.test(code), 'app script must not call replaceChildren');
});

// ---------------------------------------------------------------------------
// Visual system contracts (Task 6)
//
// A small CSS parser reads the single inline stylesheet of the built page so the
// tests can assert on real rules: theme classes, focus styles, the mobile
// breakpoint and full reduced-motion coverage of every animated selector.
// ---------------------------------------------------------------------------

function stylesheetText(html = builtHtml) {
  const styles = findAll(parseHtml(html).root, node => node.localName === 'style');
  assert.equal(styles.length, 1, 'index.html must have exactly one inline <style> element');
  return styles[0].textContent.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Returns flat rules: { selectors: string[], declarations: Map, media: string|null } and keyframe names.
function parseCss(css) {
  const rules = [];
  const keyframes = new Set();
  const matchingBrace = (text, open) => {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
      if (text[index] === '{') depth++;
      else if (text[index] === '}' && --depth === 0) return index;
    }
    throw new Error('Unbalanced braces in stylesheet');
  };
  const parseDeclarations = body => {
    const declarations = new Map();
    for (const part of body.split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      declarations.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim().replace(/\s+/g, ' '));
    }
    return declarations;
  };
  const walk = (text, media) => {
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf('{', cursor);
      if (open === -1) break;
      const prelude = text.slice(cursor, open).trim();
      const close = matchingBrace(text, open);
      const body = text.slice(open + 1, close);
      if (/^@media\b/i.test(prelude)) {
        walk(body, prelude.replace(/\s+/g, ' '));
      } else if (/^@(-webkit-)?keyframes\b/i.test(prelude)) {
        keyframes.add(prelude.split(/\s+/)[1]);
      } else if (!prelude.startsWith('@')) {
        rules.push({ selectors: prelude.split(',').map(selector => selector.trim().replace(/\s+/g, ' ')), declarations: parseDeclarations(body), media });
      }
      cursor = close + 1;
    }
  };
  walk(css, null);
  return { rules, keyframes };
}

const REDUCED_MOTION_MEDIA = /prefers-reduced-motion:\s*reduce/i;
const hasMotion = value => value !== undefined && !/^none\b/i.test(value.replace(/\s*!important$/, ''));

await test('Hero artwork is an aria-hidden inline SVG of a signal vehicle linking three combat arms to a COMMANDER node', () => {
  const document = parseHtml(builtHtml);
  const svgs = findAll(document.root, node => node.localName === 'svg');
  assert.ok(svgs.length > 0, 'index.html must contain inline SVG artwork');
  for (const svg of svgs) {
    assert.equal(svg.getAttribute('aria-hidden'), 'true', 'decorative SVG must be aria-hidden');
    assert.equal(svg.getAttribute('focusable'), 'false', 'decorative SVG must not take focus');
    assert.ok(svg.getAttribute('viewbox'), 'SVG must scale through a viewBox');
  }
  const groups = {};
  for (const id of ['tank', 'tank-gun', 'muzzle-blast', 'shell', 'dust', 'objective']) {
    const node = document.getElementById(id);
    assert.ok(node, `SVG group #${id} is required`);
    assert.equal(node.localName, 'g', `#${id} must be an SVG <g> group`);
    assert.ok(svgs.some(svg => findAll(svg, child => child === node).length), `#${id} must sit inside an aria-hidden SVG`);
    groups[id] = node;
  }
  for (const id of ['tank-gun', 'muzzle-blast']) {
    assert.ok(findAll(groups.tank, node => node === groups[id]).length, `#${id} (mast and dish beam) must be part of the signal vehicle #tank`);
  }
  const hero = document.getElementById('hero-art');
  assert.ok(hero, 'the landing hero must contain the signal art');
  assert.equal(hero.getAttribute('aria-hidden'), 'true');
  const text = hero.textContent.replace(/\s+/g, ' ');
  assert.match(text, /CONNECT · COMMUNICATE · COORDINATE/, 'the motto belongs inside the aria-hidden art');
  assert.match(groups.objective.textContent, /COMMANDER/, '#objective is the COMMANDER node');
  for (const label of ['INFANTRY', 'ARMOR', 'ARTILLERY']) assert.match(text, new RegExp(`\\b${label}\\b`), `${label} marker label`);
  for (const arm of ['infantry', 'armor', 'artillery']) {
    assert.equal(findAll(hero, node => node.localName === 'g' && (node.getAttribute('class') ?? '').split(/\s+/).includes(`arm-${arm}`)).length, 1, `one ${arm} unit marker`);
  }
  assert.ok(findAll(hero, node => node.localName === 'path' && /\blink-line\b/.test(node.getAttribute('class') ?? '')).length >= 4, 'link lines run from the dish to the COMMANDER node and the three arms');
  assert.equal(findAll(groups.objective, node => /\bimpact-pulse\b/.test(node.getAttribute('class') ?? '')).length, 1, 'the COMMANDER node pulses');
  assert.doesNotMatch(text, /OBJECTIVE|SHOCK EFFECT|FIRE SUPPORT|SURVEILLANCE|CAVALRY|MECH INF/, 'the art differs from the Armor, ISR, Artillery and Combined pictures');
});

await test('The header links to the Module 3 section of the quiz hub as an "All quizzes" link', () => {
  const app = loadApp();
  const link = byId(app, 'hub-link');
  assert.equal(link.localName, 'a');
  assert.equal(link.getAttribute('href'), HUB_URL);
  assert.equal(link.textContent.replace(/\s+/g, ' ').trim(), '← All quizzes');
  assert.ok(findAll(app.document.root, node => node.localName === 'header' && findAll(node, child => child === link).length).length, 'the link sits in the page header');
  const anchors = findAll(app.document.root, node => node.localName === 'a');
  assert.deepEqual(anchors.map(node => node.getAttribute('href')), [HUB_URL], 'the hub link is the only link');
});

await test('Page background is the fixed, inert topographic contour map with olive index contours over a paper tint', () => {
  const document = parseHtml(builtHtml);
  const terrain = findAll(document.root, node => /\bterrain\b/.test(node.getAttribute('class') ?? '') && node.localName === 'div');
  assert.equal(terrain.length, 1, 'one decorative terrain layer');
  assert.equal(terrain[0].getAttribute('aria-hidden'), 'true');
  const svg = terrain[0].children[0];
  assert.equal(svg.localName, 'svg');
  assert.equal(svg.getAttribute('viewbox'), '0 0 1200 800');
  assert.equal(svg.getAttribute('preserveaspectratio'), 'xMidYMid slice');
  const contours = findAll(svg, node => node.localName === 'g' && node.getAttribute('class') === 'contours');
  assert.equal(contours.length, 1, 'the generated contour group is embedded');
  const paths = findAll(contours[0], node => node.localName === 'path');
  assert.ok(paths.length >= 20, 'the contour map keeps its lines');
  assert.ok(paths.some(node => node.getAttribute('class') === 'major') && paths.some(node => !node.getAttribute('class')), 'minor and index contours are both drawn');
  assert.ok(paths.every(node => !node.hasAttribute('stroke') && !node.hasAttribute('style')), 'stroke colours come from CSS variables');
  const { rules } = parseCss(stylesheetText());
  const rule = selector => rules.find(item => !item.media && item.selectors.includes(selector));
  const root = rule(':root').declarations;
  const opacity = name => Number(root.get(name));
  assert.ok(opacity('--contour-minor-opacity') > 0.1 && opacity('--contour-minor-opacity') <= 0.3, 'minor contours stay faint');
  assert.ok(opacity('--contour-major-opacity') > opacity('--contour-minor-opacity') && opacity('--contour-major-opacity') <= 0.45, 'index contours are stronger but still subtle');
  assert.match(rule('.terrain .contours path').declarations.get('stroke'), /var\(--color-contour-minor\)/);
  assert.match(rule('.terrain .contours path.major').declarations.get('stroke'), /var\(--color-contour-major\)/);
  assert.equal(rule('.terrain').declarations.get('z-index'), '-1', 'the map sits behind every content surface');
  assert.ok(rules.some(item => item.selectors.includes('.terrain') && /linear-gradient/.test(item.declarations.get('background') ?? '')), 'a soft green-to-sand paper tint');
  for (const selector of ['.app', '.feedback', '.review-item']) {
    assert.match(rules.find(item => !item.media && item.selectors.includes(selector))?.declarations.get('background') ?? '', /var\(--color-surface\)/, `${selector} stays an opaque surface over the map`);
  }
  const print = rules.filter(item => item.media && /print/.test(item.media) && item.selectors.includes('.terrain'));
  assert.ok(print.some(item => /none/.test(item.declarations.get('display') ?? '')), 'print hides the map');
  const layer = builtHtml.slice(builtHtml.indexOf('<div class="terrain"'), builtHtml.indexOf('<header'));
  assert.ok(Buffer.byteLength(layer) < 20000, `the contour layer stays light (${Buffer.byteLength(layer)} bytes)`);
  assert.ok(Buffer.byteLength(builtHtml) < 250000, `page weight stays reasonable (${Buffer.byteLength(builtHtml)} bytes)`);
});

// ---------------------------------------------------------------------------
// Lesson-specific content rules for Signal Support in Combined Arms Operations.
// ---------------------------------------------------------------------------
const allQuestions = [...easyBank, ...mediumBank, ...hardBank];
const CONJUNCTION = /\b(but|because|since)\b/i;
const isListOption = option => (option.match(/[,;]/g) ?? []).length >= 2;

await test('Template CATEGORY_ORDER matches the nine handout topics in order', () => {
  const code = appScripts(parseHtml(builtHtml)).map(script => script.textContent).join('\n');
  const declared = code.match(/var CATEGORY_ORDER = \[([\s\S]*?)\];/);
  assert.ok(declared, 'CATEGORY_ORDER is declared');
  assert.deepEqual([...declared[1].matchAll(/'([^']+)'/g)].map(match => match[1]), CATEGORY_ORDER);
  assert.deepEqual(Object.keys(ALLOCATION), CATEGORY_ORDER);
  assert.equal(Object.values(ALLOCATION).reduce((sum, count) => sum + count, 0), 25);
});

await test('Every question cites substantive handout pages and the explanation names the page', () => {
  for (const item of allQuestions) {
    const label = `${item.difficulty} ${item.id}`;
    assert.ok(item.sourceSlides.every(page => page >= 1 && page <= 19), `${label} pages`);
    assert.deepEqual(item.sourceSlides, [...new Set(item.sourceSlides)].sort((a, b) => a - b), `${label} pages are sorted and unique`);
    assert.match(item.explanation, /\bPages? \d+/i, `${label} explanation must cite a handout page`);
    for (const [, page] of item.explanation.matchAll(/\bpages? (\d+)/gi)) {
      assert.ok(item.sourceSlides.includes(Number(page)), `${label} explanation cites page ${page} missing from sourceSlides`);
    }
  }
});

await test('Each bank covers every topic and all three banks span the whole handout', () => {
  const pages = new Set(allQuestions.flatMap(item => item.sourceSlides));
  for (let page = 1; page <= 19; page++) assert.ok(pages.has(page), `no question draws on handout page ${page}`);
  const corpus = allQuestions.map(item => `${item.prompt} ${item.options.join(' ')} ${item.explanation}`).join(' ');
  const terms = ['Signal Operations', 'Signal Support Operations', 'Combined Arms Operations', 'Archipelagic', 'Disaster-Prone', 'Highly Urbanized', 'Universally Connected', 'Politically', 'Collective Environment', 'Culturally Diverse', 'PMESII-PT', 'METT-TC', 'physical environment', 'cyberspace', 'electromagnetic spectrum', 'logical domain', 'people domain', 'BONTEX', 'PANET', 'VoIP', 'DBTOCS', 'HF', 'UHF', 'Combat Net Radio', 'ROIP', 'Ad hoc', 'SMMART', 'SMTF', 'electro-optic', 'CSIRT', 'Connect, Sustain, and Recover', 'Operations Focused', 'Interoperable', 'Redundant', 'Scalable', 'Secured', 'METAL', 'site survey', 'MDMP', 'Troop Leading Procedures', 'PACE', 'Alternate', 'Contingency', 'Emergency', 'C4S Annex', 'CEOI', 'CESI', 'COMSEC', 'Confidentiality', 'Integrity', 'Availability', 'Defensive Cyber Operations', 'Active Defense', 'frequency hopping', 'support, attack and protect', 'coalition', 'joint', 'disaster-response net', 'compromise', 'video teleconferencing', 'collaboration systems', 'backbone', 'mobile ad hoc networks', 'incident response plan', 'cellular phones', 'satellite phones', 'administrative and logistical requirements', 'unit policies', 'detailed security procedure'];
  for (const term of terms) assert.ok(corpus.toLowerCase().includes(term.toLowerCase()), `the banks never address "${term}"`);
});

for (const [name, bank] of [['easy', easyBank], ['medium', mediumBank], ['hard', hardBank]]) {
  await test(`${name} keys carry no give-away cues: never the only option with but/because/since or the only list`, () => {
    for (const item of bank) {
      const others = item.options.filter((_, index) => index !== item.answer);
      const key = item.options[item.answer];
      if (CONJUNCTION.test(key)) assert.ok(others.some(option => CONJUNCTION.test(option)), `${name} ${item.id}: key is the only option with but/because/since`);
      if (isListOption(key)) assert.ok(others.some(isListOption), `${name} ${item.id}: key is the only list-style option`);
    }
  });
}

await test('No two prompts are near-duplicates (word overlap below 0.4 across all 75)', () => {
  const words = text => new Set(text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(word => word.length > 3));
  const sets = allQuestions.map(item => [`${item.difficulty} ${item.id}`, words(item.prompt)]);
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const [a, left] = sets[i];
      const [b, right] = sets[j];
      const shared = [...left].filter(word => right.has(word)).length;
      assert.ok(shared / (left.size + right.size - shared) < 0.4, `${a} and ${b} prompts are too similar`);
    }
  }
});

await test('apps-script/Code.gs registers the Signal Support History tab with the 25-question default', () => {
  const source = readFileSync(join(projectRoot, 'apps-script', 'Code.gs'), 'utf8');
  assert.match(source, /^ {2}signal: 'Signal Support History',/m);
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(context.tabFor('signal'), 'Signal Support History');
  assert.equal(context.totalFor('signal'), 25);
  for (const [lesson, tab] of [['isr', 'History'], ['armor', 'Armor History'], ['fieldartillery', 'Field Artillery History'], ['armyops', 'Army Operations History'], ['combined', 'Combined Exam History']]) {
    assert.equal(context.tabFor(lesson), tab, `${lesson} tab unchanged`);
  }
  assert.equal(context.totalFor('combined'), 30);
});

await test('Easy, Medium and Hard theme classes are styled and follow the active attempt', () => {
  const { rules } = parseCss(stylesheetText());
  for (const mode of MODES) {
    assert.ok(rules.some(rule => rule.selectors.some(selector => selector.includes(`.theme-${mode}`))), `CSS must style .theme-${mode}`);
  }
  const themeClasses = app => MODES.filter(mode => app.document.body.classList.contains(`theme-${mode}`));
  for (const mode of MODES) {
    const app = loadApp();
    assert.ok(app.document.body, 'the page must have a <body>');
    assert.deepEqual(themeClasses(app), [], 'no theme before a mode starts');
    assert.equal(app.document.body.getAttribute('data-view'), 'landing');
    startConfirmed(app, mode);
    assert.deepEqual(themeClasses(app), [mode], `${mode} applies only theme-${mode}`);
    assert.equal(app.document.body.getAttribute('data-view'), 'quiz');
    assert.match(byId(app, 'quiz-heading').textContent, new RegExp(mode, 'i'), 'the difficulty is named in text, not by colour alone');
    completeAttempt(app);
    byId(app, 'btn-finish').click();
    assert.deepEqual(themeClasses(app), [mode], 'results keep the attempt theme');
    assert.equal(app.document.body.getAttribute('data-view'), 'results');
    byId(app, 'btn-retake').click();
    assert.deepEqual(themeClasses(app), [mode], 'retake keeps the same theme');
    completeAttempt(app);
    byId(app, 'btn-finish').click();
    byId(app, 'btn-choose').click();
    assert.deepEqual(themeClasses(app), [], 'choosing another difficulty clears the theme');
    assert.equal(app.document.body.getAttribute('data-view'), 'landing');
    const next = MODES[(MODES.indexOf(mode) + 1) % 3];
    byId(app, `mode-${next}`).click();
    assert.deepEqual(themeClasses(app), [next], 'switching difficulty swaps the theme');
  }
  const broken = loadApp(replaceBank(baseHtml, 'easy', '{not json'));
  assert.deepEqual(themeClasses(broken), []);
  assert.equal(broken.document.body.getAttribute('data-view'), 'unavailable');
});

await test('Focus stays visible: a :focus-visible outline exists and no rule removes outlines', () => {
  const { rules } = parseCss(stylesheetText());
  const focusRules = rules.filter(rule => !rule.media && rule.selectors.some(selector => selector.includes(':focus-visible')));
  assert.ok(focusRules.length, 'a :focus-visible rule is required');
  assert.ok(focusRules.some(rule => {
    const outline = rule.declarations.get('outline') ?? '';
    const width = Number((outline.match(/(\d+(?:\.\d+)?)px/) ?? [])[1] ?? 0);
    return width >= 2 && /solid/.test(outline);
  }), 'focus outline must be solid and at least 2px wide');
  for (const rule of rules) {
    const outline = rule.declarations.get('outline');
    assert.ok(outline === undefined || !/^(none|0)\b/.test(outline), `outline removed by ${rule.selectors.join(', ')}`);
  }
});

await test('Hover accents do not replace correct and incorrect feedback styling', () => {
  const { rules } = parseCss(stylesheetText());
  const hover = rules.flatMap(rule => rule.selectors
    .filter(selector => selector.includes('.option:hover') && rule.declarations.has('border-color')));
  assert.ok(hover.length, 'options need a hover accent');
  for (const selector of hover) {
    assert.match(selector, /:not\(\.option-correct\)/, 'hover must preserve correct answer border');
    assert.match(selector, /:not\(\.option-incorrect\)/, 'hover must preserve incorrect answer border');
  }
});

await test('Narrow screens up to 760px stack the hero and controls with 44px targets and wrapping text', () => {
  const { rules } = parseCss(stylesheetText());
  const mobile = rules.filter(rule => rule.media && /max-width:\s*760px/.test(rule.media));
  assert.ok(mobile.length, 'a @media (max-width: 760px) block is required');
  const stacks = selectorPattern => mobile.some(rule => rule.selectors.some(selector => selectorPattern.test(selector))
    && (/^1fr$/.test(rule.declarations.get('grid-template-columns') ?? '') || rule.declarations.get('flex-direction') === 'column'));
  assert.ok(stacks(/\.hero-inner\b/), 'the hero must stack into one column');
  assert.ok(stacks(/\.quiz-actions\b/) && stacks(/\.results-actions\b/), 'action buttons must stack');
  const base = selector => rules.find(rule => !rule.media && rule.selectors.includes(selector));
  for (const selector of ['button', '.option', '.study-confirm']) {
    assert.equal(base(selector)?.declarations.get('min-height'), '44px', `${selector} keeps a 44px minimum target`);
  }
  assert.equal(base('body')?.declarations.get('overflow-wrap'), 'anywhere', 'long answers must wrap');
  const art = rules.find(rule => !rule.media && rule.selectors.includes('.hero-art svg'));
  assert.ok(art && art.declarations.get('max-width') === '100%', 'hero SVG must never exceed its column');
  const terrain = rules.find(rule => !rule.media && rule.selectors.includes('.terrain'));
  assert.ok(terrain && terrain.declarations.get('position') === 'fixed' && terrain.declarations.get('overflow') === 'hidden' && terrain.declarations.get('pointer-events') === 'none', 'the decorative map layer must not affect layout width or input');
});

await test('prefers-reduced-motion: reduce sets animation and transition to none on every motion-bearing element', () => {
  const { rules, keyframes } = parseCss(stylesheetText());
  const reduced = rules.filter(rule => rule.media && REDUCED_MOTION_MEDIA.test(rule.media));
  assert.ok(reduced.length, 'a @media (prefers-reduced-motion: reduce) block is required');
  const stilled = new Set(reduced
    .filter(rule => /^none\b/.test(rule.declarations.get('animation') ?? '') && /^none\b/.test(rule.declarations.get('transition') ?? ''))
    .flatMap(rule => rule.selectors));
  for (const selector of ['#tank-gun', '#muzzle-blast', '#shell', '#dust .dust-puff', '#objective .impact-pulse', '.link-line', '.view']) {
    assert.ok(stilled.has(selector), `reduced motion must set animation: none and transition: none on ${selector}`);
  }
  const moving = rules.filter(rule => !(rule.media && REDUCED_MOTION_MEDIA.test(rule.media))
    && (hasMotion(rule.declarations.get('animation')) || hasMotion(rule.declarations.get('animation-name')) || hasMotion(rule.declarations.get('transition'))));
  assert.ok(moving.length >= 6, 'the artwork must actually be animated');
  for (const rule of moving) {
    for (const selector of rule.selectors) assert.ok(stilled.has(selector), `animated selector ${selector} is not stopped under reduced motion`);
    const name = (rule.declarations.get('animation') ?? rule.declarations.get('animation-name') ?? '').split(/\s+/).find(token => keyframes.has(token));
    if (hasMotion(rule.declarations.get('animation')) || rule.declarations.has('animation-name')) assert.ok(name, `${rule.selectors.join(', ')} uses an undefined @keyframes`);
  }
  for (const rule of reduced) {
    for (const selector of rule.selectors) {
      if (/#tank|#objective$|\.terrain-contour|\.link-line|\.arm-marker|\.hero-art/.test(selector)) {
        assert.notEqual(rule.declarations.get('display'), 'none', `static artwork ${selector} must stay visible`);
        assert.notEqual(rule.declarations.get('visibility'), 'hidden', `static artwork ${selector} must stay visible`);
      }
    }
  }
});

await test('Visual system uses no external asset URLs, fonts or data URIs', () => {
  assert.equal(baseHtml.split(HUB_URL).length - 1, 1, 'the hub link appears once');
  assert.doesNotMatch(baseHtml.replace(`href="${HUB_URL}"`, ''), /https?:\/\//i, 'no absolute URLs outside HISTORY_ENDPOINT and the hub link (inline SVG needs no xmlns)');
  assert.doesNotMatch(builtHtml, /@font-face|data:[a-z]+\//i);
  const css = stylesheetText();
  for (const [, target] of css.matchAll(/url\(\s*['"]?([^'")]*)/gi)) {
    assert.ok(target.startsWith('#'), `stylesheet url(${target}) must reference an inline fragment`);
  }
  for (const [, target] of builtHtml.matchAll(/\bhref\s*=\s*"([^"]*)"/gi)) {
    assert.ok(target.startsWith('#') || target === HUB_URL, `href ${target} must be an in-page fragment or the quiz hub`);
  }
  const { rules } = parseCss(css);
  const bodyFont = rules.find(rule => !rule.media && rule.selectors.includes('body'))?.declarations.get('font-family') ?? '';
  assert.match(bodyFont, /system-ui/, 'body uses a system font stack');
});

await test('Bandwidth Brothers banner sits above the hero with srcset, dimensions, priority and alt text', () => {
  const m = builtHtml.match(/<div class="banner">\s*<picture>([\s\S]*?)<\/picture>\s*<\/div>/);
  assert.ok(m, 'banner picture markup');
  assert.ok(builtHtml.indexOf('<div class="banner">') < builtHtml.indexOf('<header'), 'banner precedes the hero');
  assert.match(m[1], /<source media="\(max-width: 800px\)" srcset="assets\/banner-800\.jpg 1x, assets\/banner-1600\.jpg 2x">/);
  const img = m[1].match(/<img\b[^>]*>/)[0];
  assert.match(img, /\bsrcset="assets\/banner-1600\.jpg 1x"/);
  assert.match(img, /\bwidth="1600"/); assert.match(img, /\bheight="900"/);
  assert.match(img, /\bfetchpriority="high"/);
  assert.match(img, /\balt="Bandwidth Brothers banner"/);
  const css = builtHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\.banner img \{[^}]*aspect-ratio: 16 \/ 6;[^}]*object-fit: cover/);
  assert.match(css, /max-width: 600px\) \{ \.banner img \{ aspect-ratio: 16 \/ 8;/);
});

await test('Class photo is a lazy, captioned figure with exact caption and alt text', () => {
  const m = builtHtml.match(/<figure class="class-photo">([\s\S]*?)<\/figure>/);
  assert.ok(m, 'class photo figure');
  const img = m[1].match(/<img\b[^>]*>/)[0];
  assert.match(img, /\bsrcset="assets\/class-photo-800\.jpg 800w, assets\/class-photo-1600\.jpg 1600w"/);
  assert.match(img, /\bwidth="1600"/); assert.match(img, /\bheight="1200"/);
  assert.match(img, /\bloading="lazy"/); assert.match(img, /\bdecoding="async"/);
  assert.match(img, /\balt="SOAC 52 - 2026 class group photo"/);
  assert.equal(m[1].match(/<figcaption>([\s\S]*?)<\/figcaption>/)[1], 'SOAC 52 - 2026');
  const css = builtHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\.class-photo \{[^}]*max-width: 56rem;[^}]*border-radius: var\(--radius-lg\);[^}]*box-shadow:/);
});

await test('Photo srcsets reference the four asset files, and they exist on disk', () => {
  const found = new Set([...builtHtml.matchAll(/\b(?:src|srcset)="([^"]*)"/g)].flatMap(x => x[1].split(',').map(p => p.trim().split(/\s+/)[0])).filter(p => /\.jpg$/.test(p)));
  assert.deepEqual([...found].sort(), ['assets/banner-1600.jpg', 'assets/banner-800.jpg', 'assets/class-photo-1600.jpg', 'assets/class-photo-800.jpg']);
  for (const f of found) assert.ok(existsSync(join(projectRoot, f)), f + ' must exist');
});

await test('Banner and photo are hidden in print and outside the landing view', () => {
  const css = builtHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /@media print \{[\s\S]*\.banner, \.class-photo[^{]*\{ display: none !important; \}/);
  assert.match(css, /body:not\(\[data-view="landing"\]\) \.banner, body:not\(\[data-view="landing"\]\) \.class-photo \{ display: none; \}/);
  assert.ok(/<body data-view="landing">/.test(builtHtml), 'body starts on the landing view');
});

if (failures > 0) {
  console.error(`${failures} verification test(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`All ${tests} verification tests passed`);
}
