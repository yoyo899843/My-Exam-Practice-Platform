import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createAccount, issueKey } from '../src/auth.js';
import { parseCsv } from '../src/questions.js';

test('serves local Markdown modules and preserves Markdown through API, CSV and attempts', async t => {
  const db = openDatabase(':memory:');
  const userId = createAccount(db, 'markdown-test', 'test-password-123');
  const key = issueKey(db, userId, 'test');
  const server = createApp(db).listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const question = {
    type: 'short', subject: 'Markdown', chapter: '格式', language: 'zh-TW', options: [],
    question: '# 題目\n\n閱讀 **程式**：\n\n```js\nconsole.log("a,b");\n```',
    answer: '- 第一點\n- `第二點`', explanation: '> 提示\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',
  };
  for (const path of ['/vendor/marked.js', '/vendor/purify.js', '/markdown.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /img-src 'self' https: data:/);
  }
  assert.equal((await fetch(base + '/vendor/package.json')).status, 404);
  const created = await fetch(base + '/api/v1/questions', {
    method: 'POST', headers: { 'X-API-Key': key.token, 'Content-Type': 'application/json' }, body: JSON.stringify(question),
  });
  assert.equal(created.status, 201);
  const saved = await created.json();
  for (const field of ['question', 'answer', 'explanation']) assert.equal(saved[field], question[field]);
  const csv = await fetch(base + '/api/v1/questions/export', { headers: { 'X-API-Key': key.token } });
  const exported = parseCsv(await csv.text())[0];
  for (const field of ['question', 'answer', 'explanation']) assert.equal(exported[field], question[field]);
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'PracticeRoom' },
    body: JSON.stringify({ username: 'markdown-test', password: 'test-password-123' }),
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-Requested-With': 'PracticeRoom' };
  const started = await fetch(base + '/api/attempts', { method: 'POST', headers, body: JSON.stringify({ counts: { short: 1 } }) });
  assert.equal(started.status, 201);
  const attempt = await started.json();
  assert.equal(attempt.questions[0].question, question.question);
  assert.equal('answer' in attempt.questions[0], false);
  const submitted = await fetch(base + `/api/attempts/${attempt.id}/submit`, {
    method: 'POST', headers, body: JSON.stringify({ answers: { [`short:${saved.id}`]: '**我的答案**' } }),
  });
  assert.equal(submitted.status, 200);
  const review = await submitted.json();
  assert.equal(review.answers[`short:${saved.id}`], '**我的答案**');
  for (const field of ['question', 'answer', 'explanation']) assert.equal(review.questions[0][field], question[field]);
});
