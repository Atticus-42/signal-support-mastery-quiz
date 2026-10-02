import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const difficulties = ['easy', 'medium', 'hard'];

export function validateQuestion(question, expectedDifficulty, expectedId) {
  if (question === null || typeof question !== 'object' || Array.isArray(question)) {
    return ['question must be an object'];
  }

  const errors = [];
  if (!Number.isInteger(question.id) || question.id !== expectedId) {
    errors.push(`id must be integer ${expectedId}`);
  }
  if (question.difficulty !== expectedDifficulty) {
    errors.push(`difficulty must be ${expectedDifficulty}`);
  }
  for (const field of ['category', 'prompt', 'explanation']) {
    if (typeof question[field] !== 'string' || !question[field].trim()) {
      errors.push(`${field} must be a nonempty string`);
    }
  }
  if (!Array.isArray(question.tags) || question.tags.some(tag => typeof tag !== 'string' || !tag.trim())) {
    errors.push('tags must be an array of nonempty strings');
  }
  if (!Array.isArray(question.options) || question.options.length !== 4 || question.options.some(option => typeof option !== 'string' || !option.trim())) {
    errors.push('options must contain four nonempty strings');
  }
  if (!Number.isInteger(question.answer) || question.answer < 0 || question.answer > 3) {
    errors.push('answer must be an integer from 0 to 3');
  }
  if (!Array.isArray(question.sourceSlides) || question.sourceSlides.length === 0 || question.sourceSlides.some(slide => !Number.isInteger(slide) || slide < 1 || slide > 19)) {
    errors.push('sourceSlides must contain integers from 1 to 19');
  }
  return errors;
}

export function buildHtml(template, banks) {
  let html = template;
  for (const difficulty of difficulties) {
    const placeholder = `{{${difficulty.toUpperCase()}_QUESTIONS}}`;
    if (html.split(placeholder).length !== 2) {
      throw new Error(`${placeholder} must occur exactly once`);
    }
    const json = JSON.stringify(banks[difficulty]).replaceAll('<', '\\u003c');
    html = html.replace(placeholder, () => json);
  }
  return html;
}

export function build() {
  const banks = {};
  for (const difficulty of difficulties) {
    const path = join(root, 'src', 'questions', `${difficulty}.json`);
    const bank = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(bank)) throw new Error(`${path} must contain an array`);
    bank.forEach((question, index) => {
      const errors = validateQuestion(question, difficulty, index + 1);
      if (errors.length) throw new Error(`${path} question ${index + 1}: ${errors.join('; ')}`);
    });
    banks[difficulty] = bank;
  }
  const template = readFileSync(join(root, 'src', 'template.html'), 'utf8');
  const html = buildHtml(template, banks);
  writeFileSync(join(root, 'index.html'), html);
  return html;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    build();
    console.log('Built index.html');
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
