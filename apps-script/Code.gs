// Class score history for the quiz sites. Deploy as a Web app (Execute as: Me, Who has access: Anyone).
// One spreadsheet serves every lesson quiz: each lesson has its own tab (see LESSONS).
// POST (Content-Type text/plain) body: {"lesson","name","mode","score","total","percent","band","finishedAt"}
// GET  ?lesson=isr|armor|fieldartillery|armyops|combined&mode=all|easy|medium|hard&limit=100  ->  {"ok":true,"rows":[...newest first]}
// A request without "lesson" is treated as the first lesson ('isr'), so older quiz pages keep working.

var LESSONS = {
  isr: 'History',        // first quiz: ISR Operations (original tab name kept)
  armor: 'Armor History',                  // Fundamentals of Armor Operations quiz
  fieldartillery: 'Field Artillery History', // Field Artillery Operations quiz
  armyops: 'Army Operations History',        // Introduction to Army Operations quiz
  signal: 'Signal Support History',          // Signal Support in Combined Arms Operations quiz (Module 3)
  combined: 'Combined Exam History'          // 30-question exam drawn from all lessons; add more lines here for future lessons
};
var TOTALS = { combined: 30 };               // questions per attempt; lessons not listed use DEFAULT_TOTAL
var DEFAULT_TOTAL = 25;
var DEFAULT_LESSON = 'isr';
var HEADERS = ['Received', 'Name', 'Mode', 'Score', 'Total', 'Percent', 'Band', 'Finished'];
var MODES = ['easy', 'medium', 'hard'];
var BANDS = ['Mastery', 'Proficient', 'Developing', 'Needs review'];
var MAX_LIMIT = 200;

function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var tab = tabFor(data.lesson);
    if (!tab) return reply({ ok: false, error: 'unknown lesson' });
    var total = totalFor(data.lesson);
    var name = cleanName(data.name);
    var mode = String(data.mode || '').toLowerCase();
    var score = Number(data.score);
    if (name.length < 2 || name.length > 40) return reply({ ok: false, error: 'name must be 2-40 characters' });
    if (MODES.indexOf(mode) === -1) return reply({ ok: false, error: 'invalid mode' });
    if (!isInteger(score) || score < 0 || score > total) return reply({ ok: false, error: 'invalid score' });
    var percent = Math.round((score / total) * 100);
    var band = BANDS.indexOf(data.band) === -1 ? '' : data.band;
    var finished = new Date(data.finishedAt);
    if (isNaN(finished.getTime())) finished = new Date();

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      sheet(tab).appendRow([new Date(), name, mode, score, total, percent, band, finished]);
    } finally {
      lock.releaseLock();
    }
    return reply({ ok: true });
  } catch (error) {
    return reply({ ok: false, error: 'could not save' });
  }
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  var tab = tabFor(params.lesson);
  if (!tab) return reply({ ok: false, error: 'unknown lesson' });
  var mode = String(params.mode || 'all').toLowerCase();
  var limit = Math.min(Math.max(parseInt(params.limit, 10) || 100, 1), MAX_LIMIT);
  var values = sheet(tab).getDataRange().getValues().slice(1);
  var rows = [];
  for (var i = values.length - 1; i >= 0 && rows.length < limit; i--) {
    var v = values[i];
    if (mode !== 'all' && v[2] !== mode) continue;
    rows.push({
      name: String(v[1]),
      mode: String(v[2]),
      score: Number(v[3]),
      total: Number(v[4]),
      percent: Number(v[5]),
      band: String(v[6]),
      finishedAt: toIso(v[7] || v[0])
    });
  }
  return reply({ ok: true, rows: rows });
}

function totalFor(lesson) {
  var key = String(lesson || DEFAULT_LESSON).toLowerCase();
  return TOTALS.hasOwnProperty(key) ? TOTALS[key] : DEFAULT_TOTAL;
}

// Only lessons listed in LESSONS are accepted, so callers cannot create arbitrary tabs.
function tabFor(lesson) {
  var key = String(lesson || DEFAULT_LESSON).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LESSONS, key) ? LESSONS[key] : null;
}

function sheet(name) {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var target = book.getSheetByName(name) || book.insertSheet(name);
  if (target.getLastRow() === 0) {
    target.appendRow(HEADERS);
    target.setFrozenRows(1);
  }
  return target;
}

// Strips control characters and a leading formula trigger so names cannot run as spreadsheet formulas.
function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/^[=+\-@]+/, '').trim().slice(0, 40);
}

function isInteger(n) {
  return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
}

function toIso(value) {
  var date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? '' : date.toISOString();
}

function reply(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
