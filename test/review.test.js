import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer } from '../public/markdown.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createAccount } from '../src/auth.js';
import { insertQuestion } from '../src/questions.js';

async function setup(t) {
  const db = openDatabase(':memory:');
  const userId = createAccount(db, 'review-test', 'test-password-123');
  createAccount(db, 'other-user', 'test-password-123');
  const add = (type, subject, chapter, answer, extra = {}) => insertQuestion(db, userId, {
    type, subject, chapter, language: 'zh-TW', question: `${subject}-${chapter}-${type}`, explanation: '說明',
    options: ['single', 'multiple'].includes(type) ? ['選項一', '選項二', '選項三'] : [], answer, ...extra,
  });
  const q = {
    s1: add('single', '科目A', '章1', 0, { question: 's1' }),
    s2: add('single', '科目A', '章1', 1, { question: 's2' }),
    m1: add('multiple', '科目A', '章2', [0, 1], { question: 'm1' }),
    s3: add('single', '科目B', '章3', 0, { question: 's3' }),
    short: add('short', '科目A', '章1', '參考', { question: 'short' }),
  };
  const server = createApp(db).listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async username => (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'PracticeRoom' },
    body: JSON.stringify({ username, password: 'test-password-123' }),
  })).headers.get('set-cookie').split(';')[0];
  const cookie = await login('review-test');
  const call = (cookieValue = cookie) => async (path, method = 'GET', body) => {
    const response = await fetch(base + '/api' + path, { method, headers: { Cookie: cookieValue, 'Content-Type': 'application/json', 'X-Requested-With': 'PracticeRoom' }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const api = call();
  const key = x => `${x.type}:${x.id}`;
  // Builds an attempt through the normal practice flow, then answers and submits it.
  async function practice(counts, answersFor, submit = true) {
    const attempt = (await api('/attempts', 'POST', { counts })).body;
    const answers = Object.fromEntries(attempt.questions.flatMap(x => { const value = answersFor(x); return value === undefined ? [] : [[key(x), value]]; }));
    if (submit) return (await api(`/attempts/${attempt.id}/submit`, 'POST', { answers })).body;
    await api(`/attempts/${attempt.id}`, 'PATCH', { answers });
    return attempt;
  }
  return { db, q, base, cookie, api, otherApi: call(await login('other-user')), key, practice };
}

test('wrong-question review reads history without changing it and starts a normal attempt', async t => {
  const { db, q, api, otherApi, key, practice } = await setup(t);
  const correct = { [key(q.s1)]: 0, [key(q.s2)]: 1, [key(q.m1)]: [0, 1], [key(q.s3)]: 0 };
  // 1st attempt: s1 wrong, s2 right, m1 wrong, s3 unanswered, short written.
  await practice({ single: 3, multiple: 1, short: 1 }, x => ({ [key(q.s1)]: 1, [key(q.s2)]: 1, [key(q.m1)]: [0], [key(q.short)]: '作答' })[key(x)]);
  // 2nd attempt: every single-choice question right, so s1 and s3 are corrected.
  await practice({ single: 3 }, x => correct[key(x)]);
  // An unsubmitted attempt with a wrong answer must not count.
  await practice({ single: 3 }, x => key(x) === key(q.s2) ? 0 : undefined, false);

  const before = JSON.stringify(db.prepare('SELECT * FROM attempts ORDER BY id').all());
  const catalog = (await api('/review/catalog')).body;
  assert.deepEqual(catalog, {
    total: 3, pending: 1,
    chapterGroups: [
      { subject: '科目A', chapters: [{ chapter: '章1', total: 1, pending: 0 }, { chapter: '章2', total: 1, pending: 1 }] },
      { subject: '科目B', chapters: [{ chapter: '章3', total: 1, pending: 0 }] },
    ],
  });
  assert.deepEqual((await otherApi('/review/catalog')).body, { total: 0, pending: 0, chapterGroups: [] }, 'history is per account');

  // Edits in the bank apply to review; deleted questions drop out.
  db.prepare('UPDATE single_questions SET question=? WHERE id=?').run('s1（已修正）', q.s1.id);
  db.prepare('DELETE FROM single_questions WHERE id=?').run(q.s3.id);
  assert.equal((await api('/review/catalog')).body.total, 2);

  const all = await api('/review/attempts', 'POST', { count: 2 });
  assert.equal(all.status, 201);
  assert.equal(all.body.title, '錯題複習');
  assert.equal(all.body.status, 'active');
  assert.deepEqual(all.body.questions.map(key).sort(), [key(q.m1), key(q.s1)].sort());
  assert.equal(all.body.questions.find(x => x.id === q.s1.id && x.type === 'single').question, 's1（已修正）');
  assert.ok(all.body.questions.every(x => !('answer' in x) && !('explanation' in x)), 'active review hides answers like practice');

  const chapter = await api('/review/attempts', 'POST', { count: 1, chapterScopes: [{ subject: '科目A', chapter: '章1' }] });
  assert.equal(chapter.body.title, '錯題複習 · 科目A / 章1');
  assert.deepEqual(chapter.body.questions.map(key), [key(q.s1)]);
  const pending = await api('/review/attempts', 'POST', { count: 1, onlyPending: true });
  assert.deepEqual(pending.body.questions.map(key), [key(q.m1)]);

  for (const [body, message] of [
    [{ count: 2, onlyPending: true }, '符合條件的錯題只有 1 題'],
    [{ count: 1, chapterScopes: [{ subject: '科目B', chapter: '章3' }] }, '沒有符合條件的錯題'],
    [{ count: 0 }, '每次複習請選擇 1–200 題'],
    [{ count: 201 }, '每次複習請選擇 1–200 題'],
    [{ count: 1, onlyPending: 'yes' }, '複習範圍格式錯誤'],
    [{ count: 1, chapterScopes: 'bad' }, '章節格式錯誤'],
  ]) {
    const response = await api('/review/attempts', 'POST', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error, message);
  }

  // Existing attempts are byte-for-byte unchanged; only the three review attempts were added.
  const after = db.prepare('SELECT * FROM attempts ORDER BY id').all();
  assert.equal(JSON.stringify(after.slice(0, 3)), before);
  assert.equal(after.length, 6);

  // A submitted review is ordinary history: answering m1 right clears it from the pending list.
  await api(`/attempts/${pending.body.id}/submit`, 'POST', { answers: { [key(q.m1)]: [0, 1] } });
  const updated = (await api('/review/catalog')).body;
  assert.equal(updated.total, 2);
  assert.equal(updated.pending, 0);
});

// Loads the real UI code into jsdom, signed in, at the given hash.
async function loadUi(t, base, cookie, hash) {
  const dom = new JSDOM(await (await fetch(base)).text(), { url: `${base}/#${hash}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.fetch = (path, options = {}) => fetch(new URL(path, base), { ...options, headers: { ...options.headers, Cookie: cookie } });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.assign(window, { Marked, DOMPurify: createDOMPurify(window), createMarkdownRenderer });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  await window.eval(`(async () => { ${source.replace(/^import .*;\n/gm, '')} })()`);
  async function until(check) {
    const deadline = Date.now() + 3000;
    while (!check()) { assert.ok(Date.now() < deadline, 'UI did not reach the expected state'); await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  return { window, document: window.document, until };
}

test('submitted attempt shows a result table that jumps to questions', async t => {
  const { q, base, cookie, key, practice } = await setup(t);
  const attempt = await practice({ single: 3, multiple: 1, short: 1 }, x => ({ [key(q.s1)]: 1, [key(q.s2)]: 1, [key(q.m1)]: [0], [key(q.short)]: '作答' })[key(x)]);
  const expected = attempt.questions.map(x => ({ [key(q.s1)]: ['wrong', '✗', '答錯'], [key(q.s2)]: ['correct', '✓', '答對'], [key(q.m1)]: ['wrong', '✗', '答錯'], [key(q.s3)]: ['wrong', '✗', '答錯（未作答）'], [key(q.short)]: ['ungraded', '—', '自行對照'] })[key(x)]);
  const { window, document, until } = await loadUi(t, base, cookie, `attempt/${attempt.id}`);
  await until(() => document.querySelector('#result-grid'));
  const cells = () => [...document.querySelectorAll('.result-cell')];
  const heading = () => document.querySelector('#question-heading').textContent.trim();
  assert.ok(document.querySelector('#result-panel').open, 'table is open after submitting');
  assert.match(document.querySelector('#result-panel summary').textContent, /答錯 3 題/);
  assert.deepEqual([...document.querySelectorAll('.legend-item')].map(el => el.textContent), ['✓答對', '✗答錯', '—自行對照']);
  assert.deepEqual(cells().map(el => [el.querySelector('.result-number').textContent, el.querySelector('.result-mark').textContent]), expected.map(([, mark], i) => [String(i + 1), mark]));
  assert.deepEqual(cells().map(el => el.className.split(' ')[1]), expected.map(([name]) => name));
  assert.deepEqual(cells().map(el => el.getAttribute('aria-label')), expected.map(([, , label], i) => `第 ${i + 1} 題，${label}`));
  assert.equal(document.querySelector('.result-cell.current').dataset.index, '0');

  // Clicking a cell opens that question and keeps the table where it was.
  const multipleIndex = attempt.questions.findIndex(x => x.type === 'multiple');
  cells()[multipleIndex].click();
  await until(() => heading() === 'm1');
  assert.equal(document.querySelector('.result-cell.current').dataset.index, String(multipleIndex));
  assert.equal(document.querySelector('.result-cell[aria-current]').dataset.index, String(multipleIndex));
  assert.equal(document.querySelector('.result-status').textContent, '✗ 錯誤');
  // Footer buttons use the same ✓/✗ meaning after submitting.
  assert.deepEqual([...document.querySelectorAll('.question-dots .dot.current .mark')].map(el => el.textContent), ['✗']);

  // "Next wrong" walks through every wrong question in order and wraps around.
  const wrongIndexes = expected.flatMap(([name], i) => name === 'wrong' ? [i] : []);
  const visited = [];
  for (let n = 0; n < wrongIndexes.length; n++) {
    const target = Number(document.querySelector('#next-wrong').dataset.index);
    visited.push(target);
    document.querySelector('#next-wrong').click();
    await until(() => document.querySelector('.result-cell.current')?.dataset.index === String(target));
  }
  assert.deepEqual([...visited].sort(), wrongIndexes, 'every wrong question is reached');
  assert.equal(new Set(visited).size, wrongIndexes.length);

  // "Only wrong" and a collapsed table both survive moving between questions.
  document.querySelector('#wrong-only').click();
  assert.ok(document.querySelector('#result-grid').classList.contains('wrong-only'));
  const panel = document.querySelector('#result-panel');
  panel.open = false; panel.dispatchEvent(new window.Event('toggle'));
  document.querySelector('.result-cell.wrong:not(.current)').click();
  await until(() => document.querySelector('#result-panel') !== panel);
  assert.equal(document.querySelector('#result-panel').open, false);
  assert.ok(document.querySelector('#result-grid').classList.contains('wrong-only'));
  assert.ok(document.querySelector('#wrong-only').checked);
});

test('results list every option with the correct answer and the learner\'s choice marked', async t => {
  const { q, base, cookie, key, practice } = await setup(t);
  // s1: picked B, correct A. m1: picked A only, correct A+B. s2: picked B, correct B. s3: unanswered, correct A.
  const attempt = await practice({ single: 3, multiple: 1, short: 1 }, x => ({ [key(q.s1)]: 1, [key(q.s2)]: 1, [key(q.m1)]: [0], [key(q.short)]: '作答' })[key(x)]);
  const { document, until } = await loadUi(t, base, cookie, `attempt/${attempt.id}`);
  await until(() => document.querySelector('#result-grid'));
  const open = async target => {
    document.querySelector(`.result-cell[data-index="${attempt.questions.findIndex(x => key(x) === key(target))}"]`).click();
    await until(() => document.querySelector('#question-heading').textContent.trim() === target.question);
  };
  const rows = () => [...document.querySelectorAll('.review-choice')].map(li => ({
    letter: li.querySelector('.choice-letter').textContent, text: li.querySelector('.option-text').textContent.trim(),
    state: ['correct', 'wrong', 'chosen'].filter(name => li.classList.contains(name)).join(' '),
    tags: [...li.querySelectorAll('.choice-tag')].map(el => el.textContent),
  }));
  const summary = () => document.querySelector('.answer-summary').textContent;

  await open(q.s1);
  assert.deepEqual(rows(), [
    { letter: 'A', text: '選項一', state: 'correct', tags: ['✓ 正確答案'] },
    { letter: 'B', text: '選項二', state: 'wrong chosen', tags: ['✗ 你的選擇'] },
    { letter: 'C', text: '選項三', state: '', tags: [] },
  ]);
  assert.equal(summary(), '你的答案：B · 正確答案：A');
  assert.equal(document.querySelector('.answer-box'), null, 'choice results no longer repeat option text in boxes');

  await open(q.m1);
  assert.deepEqual(rows().map(r => [r.letter, r.state, r.tags]), [
    ['A', 'correct chosen', ['✓ 正確答案', '你的選擇']],
    ['B', 'correct', ['✓ 正確答案', '漏選']],
    ['C', '', []],
  ]);
  assert.equal(summary(), '你的答案：A · 正確答案：A、B');
  assert.equal(document.querySelectorAll('.choice-tag.missed').length, 1);

  await open(q.s2);
  assert.deepEqual(rows().map(r => r.state), ['', 'correct chosen', '']);
  await open(q.s3);
  assert.deepEqual(rows().map(r => r.state), ['correct', '', '']);
  assert.equal(summary(), '你的答案：未作答 · 正確答案：A');

  // Written questions keep the answer and reference boxes.
  await open(q.short);
  assert.equal(document.querySelector('.review-choices'), null);
  assert.deepEqual([...document.querySelectorAll('.answer-box h2')].map(el => el.textContent), ['你的答案', '參考答案']);
  assert.equal(document.querySelectorAll('.answer-box')[1].textContent.includes('參考'), true);
});

test('a fully correct attempt has no wrong-only toggle or next-wrong button', async t => {
  const { q, base, cookie, key, practice } = await setup(t);
  const attempt = await practice({ single: 2 }, x => ({ [key(q.s1)]: 0, [key(q.s2)]: 1, [key(q.s3)]: 0 })[key(x)]);
  const { document, until } = await loadUi(t, base, cookie, `attempt/${attempt.id}`);
  await until(() => document.querySelector('#result-grid'));
  assert.deepEqual([...document.querySelectorAll('.result-cell .result-mark')].map(el => el.textContent), ['✓', '✓']);
  assert.equal(document.querySelector('#wrong-only'), null);
  assert.equal(document.querySelector('#next-wrong'), null);
  assert.doesNotMatch(document.querySelector('#result-panel summary').textContent, /答錯/);
});

test('active attempt keeps the answered marks and has no result table', async t => {
  const { q, base, cookie, key, practice } = await setup(t);
  const attempt = await practice({ single: 3 }, x => key(x) === key(q.s1) ? 0 : undefined, false);
  const { document, until } = await loadUi(t, base, cookie, `attempt/${attempt.id}`);
  await until(() => document.querySelector('#question-heading'));
  assert.equal(document.querySelector('#result-panel'), null);
  const s1Index = attempt.questions.findIndex(x => key(x) === key(q.s1));
  // With three questions the footer shows every button.
  const dot = document.querySelector(`.question-dots .dot[data-index="${s1Index}"]`);
  assert.ok(dot.classList.contains('answered'));
  assert.equal(dot.getAttribute('aria-label'), `第 ${s1Index + 1} 題，已作答`);
  assert.equal(dot.querySelector('.mark').textContent, '✓');
  assert.equal(document.querySelectorAll('.question-dots .mark').length, 1, 'unanswered questions have no mark');
});

test('review page selects chapters, follows the available count and opens the attempt', async t => {
  const { q, base, cookie, key, practice } = await setup(t);
  await practice({ single: 3, multiple: 1 }, x => ({ [key(q.s1)]: 1, [key(q.s2)]: 0, [key(q.m1)]: [2], [key(q.s3)]: 0 })[key(x)]);
  await practice({ single: 3 }, x => ({ [key(q.s1)]: 0, [key(q.s2)]: 0, [key(q.s3)]: 0 })[key(x)]);
  // History: s1 wrong then right; s2 wrong twice; m1 wrong. Total 3, still wrong 2.
  const { window, document, until } = await loadUi(t, base, cookie, 'review');
  await until(() => document.querySelector('#review-form'));
  const form = document.querySelector('#review-form'), available = () => document.querySelector('#review-available').textContent;
  assert.equal(document.querySelector('.nav-button.active').textContent, '錯題');
  assert.deepEqual([...document.querySelectorAll('.chapter-group legend')].map(el => el.textContent), ['科目A']);
  assert.deepEqual([...form.querySelectorAll('[name=chapter]')].map(el => el.closest('label').textContent), ['章1 （2 題）', '章2 （1 題）']);
  assert.equal(available(), '3');
  assert.equal(form.elements.count.value, '3');
  form.elements.onlyPending.click();
  assert.equal(available(), '2');
  assert.equal(form.elements.count.value, '2');
  assert.deepEqual([...form.querySelectorAll('.chapter-count')].map(el => el.textContent), ['1', '1']);
  form.querySelector('[name=chapter]').click();
  assert.equal(available(), '1');
  assert.equal(form.elements.count.value, '1');
  assert.equal(document.querySelector('#review-start').disabled, false);
  form.elements.count.value = '5'; form.elements.count.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(form.elements.count.value, '1', 'count is capped at what is available');
  document.querySelector('#review-start').click();
  await until(() => document.querySelector('#question-heading'));
  assert.match(window.location.hash, /^#attempt\/\d+$/);
  assert.equal(document.querySelector('#question-heading').textContent.trim(), 's2');
  assert.equal(document.querySelectorAll('.question-dots .dot').length, 1);
  // The history page links here too.
  window.location.hash = 'history';
  await until(() => document.querySelector('#content [data-page="review"]'));
  assert.match(document.querySelector('#content .record strong').textContent, /^錯題複習 · 科目A \/ 章1$/);
});
