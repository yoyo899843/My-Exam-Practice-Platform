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

test('renders the bank, live editor preview, all answer types and review with working controls', async t => {
  const db = openDatabase(':memory:');
  const userId = createAccount(db, 'markdown-ui', 'test-password-123');
  const questions = ['single', 'multiple', 'short', 'essay'].map(type => insertQuestion(db, userId, {
    type, subject: '測試', chapter: 'Markdown', language: 'zh-TW',
    question: '## 題目\n\n請閱讀 **內容**\n\n```js\nconst x = 1;\n```',
    options: ['single', 'multiple'].includes(type) ? ['**正確**\n\n`code`', '[文件](https://example.com/)\n\n*其他*'] : [],
    answer: type === 'single' ? 0 : type === 'multiple' ? [0, 1] : '**參考答案**\n\n- 要點',
    explanation: '## 說明\n\n| A | B |\n| --- | --- |\n| **1** | `2` |',
  }));
  const server = createApp(db).listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'PracticeRoom' },
    body: JSON.stringify({ username: 'markdown-ui', password: 'test-password-123' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'PracticeRoom' };
  const dom = new JSDOM(await (await fetch(base)).text(), { url: base + '/#bank', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.fetch = (path, options = {}) => fetch(new URL(path, base), { ...options, headers: { ...options.headers, Cookie: cookie } });
  // jsdom supplies DOM behavior but does not implement native dialog methods.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.assign(window, { Marked, DOMPurify: createDOMPurify(window), createMarkdownRenderer });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // Load the actual UI code with its three imports supplied in the jsdom realm.
  await window.eval(`(async () => { ${source.replace(/^import .*;\n/gm, '')} })()`);
  async function until(check) {
    const deadline = Date.now() + 3000;
    while (!check()) {
      assert.ok(Date.now() < deadline, 'UI did not reach the expected state');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  assert.equal(document.querySelectorAll('.question-summary h2').length, 4);
  assert.equal(document.querySelector('.question-summary pre code').textContent, 'const x = 1;\n');
  document.querySelector('[data-action="edit-question"][data-type="single"]').click();
  await until(() => document.querySelector('#question-form'));
  const form = document.querySelector('#question-form');
  assert.equal(form.elements.question.value, questions[0].question);
  const preview = document.querySelector('#question-preview');
  preview.open = true;
  preview.dispatchEvent(new window.Event('toggle'));
  assert.equal(document.querySelector('#question-preview-content strong').textContent, '內容');
  form.elements.question.value = '**更新預覽**';
  form.elements.question.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#question-preview-content strong').textContent, '更新預覽');
  document.querySelector('#add-option').click();
  assert.equal(document.querySelectorAll('#option-fields textarea').length, 3);
  assert.match(document.querySelector('#question-preview-content').textContent, /選項 C/);
  document.querySelector('[data-remove="2"]').click();
  assert.doesNotMatch(document.querySelector('#question-preview-content').textContent, /選項 C/);
  document.querySelector('#modal [data-action="close-modal"]').click();

  const started = await fetch(base + '/api/attempts', { method: 'POST', headers, body: JSON.stringify({ counts: { single: 1, multiple: 1, short: 1, essay: 1 } }) });
  const attempt = await started.json();
  window.location.hash = `attempt/${attempt.id}`;
  await until(() => document.querySelector('.option-text strong'));
  assert.equal(document.querySelector('#question-heading h2').textContent, '題目');
  document.querySelector('.option-text strong').click();
  assert.equal(document.querySelector('#answer-option-0').checked, true);
  const link = document.querySelector('.option-text a');
  link.addEventListener('click', event => event.preventDefault());
  link.click();
  assert.equal(document.querySelector('#answer-option-1').checked, false);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }));
  assert.equal(document.querySelector('#answer-option-1').checked, true);
  const jump = async value => {
    const select = document.querySelector('#question-jump');
    select.value = String(value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await until(() => document.querySelector('#question-heading')?.getAttribute('aria-label') === `第 ${value + 1} 題`);
  };
  await jump(1);
  document.querySelector('#answer-option-0').click();
  document.querySelector('#answer-option-1').click();
  document.querySelector('#answer-text-1 em').click();
  assert.equal(document.querySelector('#answer-option-1').checked, false);
  for (const i of [2, 3]) {
    await jump(i);
    const answer = document.querySelector('#written-answer');
    answer.value = '**我的答案**\n\n- 要點';
    answer.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  document.querySelector('[data-action="submit-attempt"]').click();
  document.querySelector('[data-action="confirm-submit"]').click();
  await until(() => document.querySelector('.review-choices'));
  assert.equal(document.querySelectorAll('.review-choice .option-text').length, 2, 'every option is shown after submitting');
  assert.equal(document.querySelector('.review-choice.chosen .option-text em').textContent, '其他');
  assert.equal(document.querySelector('.review-choice.correct .option-text strong').textContent, '正確');
  await jump(1);
  assert.equal(document.querySelectorAll('.review-choice.correct').length, 2);
  for (const i of [2, 3]) {
    await jump(i);
    assert.equal(document.querySelector('.answer-box strong').textContent, '我的答案');
    assert.equal(document.querySelectorAll('.answer-box')[1].querySelector('strong').textContent, '參考答案');
  }
  document.querySelector('[data-action="explanation"]').click();
  assert.equal(document.querySelector('#modal .markdown h2').textContent, '說明');
  assert.equal(document.querySelector('#modal tbody strong').textContent, '1');
});
