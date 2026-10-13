import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { openDatabase, transaction } from './db.js';
import { hashToken, newToken, checkPassword, passwordHash, issueKey } from './auth.js';
import { questionTypes, typeFor, validateQuestion } from './question-types.js';
import { allQuestions, insertQuestion, importQuestions, parseCsv, exportCsv, unpack } from './questions.js';

const error = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const publicQuestion = ({ answer, explanation, user_id, ...q }) => q;
const now = () => new Date().toISOString();
function cookieToken(req) { return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('practice_session='))?.slice(17); }

export function createApp(db = openDatabase()) {
  const app = express();
  app.locals.db = db;
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'form-action': ["'self'"], 'default-src': ["'self'"], 'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null } } }));
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 8 * 60 * 60 * 1000 };
  const sessionAuth = (req, _res, next) => {
    const token = cookieToken(req);
    req.user = token && db.prepare('SELECT u.id,u.username FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(hashToken(token), Date.now());
    if (!req.user) return next(Object.assign(new Error('請先登入'), { status: 401 }));
    next();
  };
  // Custom header is required on cookie-authenticated mutations; cross-origin requests cannot supply it without CORS.
  app.use('/api', (req, _res, next) => {
    if (!req.path.startsWith('/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'PracticeRoom') return next(Object.assign(new Error('無效的請求來源'), { status: 403 }));
    next();
  });
  const dummyHash = passwordHash(newToken());
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '登入嘗試過多，請稍後再試' } });
  app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    const user = typeof username === 'string' && db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const valid = await checkPassword(password, user?.password_hash || dummyHash);
    if (!user || !valid) error('帳號或密碼不正確', 401);
    // Account deletion/password replacement during password verification invalidates the login.
    if (!db.prepare('SELECT id FROM users WHERE id=? AND password_hash=?').get(user.id, user.password_hash)) error('帳號或密碼已變更，請重新登入', 401);
    const token = newToken();
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    const old = cookieToken(req);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(old));
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + cookieOptions.maxAge);
    res.cookie('practice_session', token, cookieOptions).json({ username: user.username });
  });
  app.post('/api/logout', sessionAuth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(cookieToken(req)));
    res.clearCookie('practice_session', { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });
  app.get('/api/me', sessionAuth, (req, res) => res.json(req.user));

  const questionRouter = express.Router();
  questionRouter.get('/types', (_req, res) => res.json(Object.entries(questionTypes).map(([id, t]) => ({ id, label: t.label, autoGraded: ['single', 'multiple'].includes(id) }))));
  questionRouter.get('/catalog', (req, res) => {
    const questions = allQuestions(db);
    const filtered = allQuestions(db, req.query);
    res.json({ total: questions.length, counts: Object.fromEntries(Object.keys(questionTypes).map(t => [t, filtered.filter(q => q.type === t).length])),
      subjects: [...new Set(questions.map(q => q.subject))].sort(),
      chapters: [...new Set(questions.filter(q => !req.query.subject || q.subject === req.query.subject).map(q => q.chapter))].sort(),
      languages: [...new Set(questions.map(q => q.language))].sort() });
  });
  questionRouter.get('/questions/export', (req, res) => res.type('text/csv; charset=utf-8').attachment('questions.csv').send(exportCsv(allQuestions(db, req.query))));
  questionRouter.post('/questions/import', (req, res) => {
    const inserted = importQuestions(db, req.user.id, parseCsv(req.body?.csv));
    res.status(201).json({ imported: inserted.length });
  });
  questionRouter.post('/questions/bulk', (req, res) => res.status(201).json({ questions: importQuestions(db, req.user.id, req.body?.questions) }));
  questionRouter.get('/questions', (req, res) => {
    const questions = allQuestions(db, req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json({ total: questions.length, page, limit, questions: questions.slice((page - 1) * limit, page * limit) });
  });
  questionRouter.post('/questions', (req, res) => res.status(201).json(insertQuestion(db, req.user.id, req.body)));
  questionRouter.get('/questions/:type/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${typeFor(req.params.type).table} WHERE id=?`).get(req.params.id);
    if (!row) error('找不到題目', 404);
    res.json(unpack(row, req.params.type));
  });
  questionRouter.put('/questions/:type/:id', (req, res) => {
    if (req.body?.type !== req.params.type) error('編輯時不可變更題型；請建立新題目');
    const q = validateQuestion(req.body);
    const result = db.prepare(`UPDATE ${typeFor(q.type).table} SET subject=?,chapter=?,question=?,answer=?,explanation=?,language=?,options=?,updated_at=? WHERE id=?`).run(q.subject, q.chapter, q.question, JSON.stringify(q.answer), q.explanation, q.language, JSON.stringify(q.options), now(), req.params.id);
    if (!result.changes) error('找不到題目', 404);
    res.json({ ...q, id: Number(req.params.id) });
  });
  questionRouter.delete('/questions/:type/:id', (req, res) => {
    const result = db.prepare(`DELETE FROM ${typeFor(req.params.type).table} WHERE id=?`).run(req.params.id);
    if (!result.changes) error('找不到題目', 404);
    res.json({ ok: true });
  });
  app.use('/api/v1', rateLimit({ windowMs: 60000, limit: 120, message: { error: 'API 請求過多，請稍後重試' } }), (req, _res, next) => {
    const key = req.get('X-API-Key');
    req.user = key && db.prepare('SELECT u.id,u.username FROM users u JOIN api_keys k ON k.user_id=u.id WHERE k.key_hash=?').get(hashToken(key));
    if (!req.user) return next(Object.assign(new Error('無效的 API key'), { status: 401 }));
    next();
  }, questionRouter);
  app.use('/api', sessionAuth, questionRouter);

  const attemptRouter = express.Router();
  function getAttempt(req) {
    const attempt = db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!attempt) error('找不到作答紀錄', 404);
    return attempt;
  }
  function attemptView(attempt) {
    const questions = JSON.parse(attempt.questions_json);
    const { questions_json, answers_json, results_json, user_id, ...meta } = attempt;
    return { ...meta, questions: attempt.status === 'submitted' ? questions : questions.map(publicQuestion), answers: JSON.parse(answers_json), results: results_json ? JSON.parse(results_json) : null };
  }
  function validateAnswers(answers, questions) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) error('作答格式錯誤');
    for (const [key, value] of Object.entries(answers)) {
      const q = questions.find(x => `${x.type}:${x.id}` === key);
      if (!q || !typeFor(q.type).validateResponse(value, q)) error('答案格式錯誤');
    }
  }
  attemptRouter.get('/stats', (req, res) => {
    const records = db.prepare("SELECT results_json,duration_seconds FROM attempts WHERE user_id=? AND status='submitted'").all(req.user.id);
    const results = records.flatMap(r => JSON.parse(r.results_json));
    const graded = results.filter(r => r.correct !== null);
    res.json({ completed: records.length, answered: results.length, seconds: records.reduce((n, r) => n + r.duration_seconds, 0), accuracy: graded.length ? Math.round(graded.filter(r => r.correct).length / graded.length * 100) : null });
  });
  attemptRouter.get('/attempts', (req, res) => {
    res.json(db.prepare('SELECT id,title,status,started_at,submitted_at,duration_seconds,results_json,questions_json FROM attempts WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id).map(({ questions_json, results_json, ...a }) => {
      const results = results_json ? JSON.parse(results_json) : [];
      return { ...a, count: JSON.parse(questions_json).length, correct: results.filter(r => r.correct === true).length, graded: results.filter(r => r.correct !== null).length };
    }));
  });
  attemptRouter.post('/attempts', (req, res) => {
    const { counts, subject, chapters = [], language } = req.body || {};
    if (!Array.isArray(chapters) || chapters.length > 200 || chapters.some(c => typeof c !== 'string')) error('章節格式錯誤');
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) error('請選擇題數');
    for (const [type, count] of Object.entries(counts)) { typeFor(type); if (!Number.isInteger(count) || count < 0 || count > 100) error('每種題型請選擇 0–100 題'); }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total < 1 || total > 200) error('每次練習請選擇 1–200 題');
    const pool = allQuestions(db, { subject, chapter: chapters, language });
    const selected = [];
    for (const [type, count] of Object.entries(counts)) {
      const available = pool.filter(q => q.type === type);
      if (available.length < count) error(`${typeFor(type).label}只有 ${available.length} 題`);
      for (let i = available.length - 1; i > 0; i--) { const j = randomInt(i + 1); [available[i], available[j]] = [available[j], available[i]]; }
      selected.push(...available.slice(0, count));
    }
    const id = Number(db.prepare('INSERT INTO attempts(user_id,title,questions_json,started_at) VALUES(?,?,?,?)').run(req.user.id, [subject || '綜合練習', chapters.join('、')].filter(Boolean).join(' · '), JSON.stringify(selected), now()).lastInsertRowid);
    req.params.id = id;
    res.status(201).json(attemptView(getAttempt(req)));
  });
  attemptRouter.get('/attempts/:id', (req, res) => res.json(attemptView(getAttempt(req))));
  attemptRouter.delete('/attempts/:id', (req, res) => {
    db.prepare('DELETE FROM attempts WHERE id=?').run(getAttempt(req).id);
    res.json({ ok: true });
  });
  attemptRouter.patch('/attempts/:id', (req, res) => {
    const attempt = getAttempt(req);
    if (attempt.status !== 'active') error('此練習已交卷', 409);
    const questions = JSON.parse(attempt.questions_json);
    const { answers, current_index = attempt.current_index } = req.body || {};
    validateAnswers(answers, questions);
    if (!Number.isInteger(current_index) || current_index < 0 || current_index >= questions.length) error('頁碼錯誤');
    db.prepare('UPDATE attempts SET answers_json=?,current_index=? WHERE id=?').run(JSON.stringify(answers), current_index, attempt.id);
    res.json({ saved: true });
  });
  attemptRouter.post('/attempts/:id/submit', (req, res) => {
    const view = transaction(db, () => {
      const attempt = getAttempt(req);
      if (attempt.status === 'submitted') return attemptView(attempt);
      const questions = JSON.parse(attempt.questions_json);
      const answers = req.body?.answers ?? JSON.parse(attempt.answers_json);
      validateAnswers(answers, questions);
      const results = questions.map(q => ({ key: `${q.type}:${q.id}`, correct: typeFor(q.type).grade(answers[`${q.type}:${q.id}`] ?? null, q) }));
      const submittedAt = now();
      db.prepare("UPDATE attempts SET status='submitted',answers_json=?,submitted_at=?,duration_seconds=?,results_json=? WHERE id=?").run(JSON.stringify(answers), submittedAt, Math.max(0, Math.floor((Date.parse(submittedAt) - Date.parse(attempt.started_at)) / 1000)), JSON.stringify(results), attempt.id);
      return attemptView(getAttempt(req));
    });
    res.json(view);
  });
  app.use('/api', sessionAuth, attemptRouter);

  // Key management is session-only so an API key cannot mint or revoke keys.
  const accountRouter = express.Router();
  accountRouter.get('/keys', (req, res) => res.json(db.prepare('SELECT id,label,prefix,created_at FROM api_keys WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
  accountRouter.post('/keys', (req, res) => {
    const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim() : 'AI';
    if (label.length > 100) error('名稱最多 100 個字元');
    res.status(201).json(issueKey(db, req.user.id, label));
  });
  accountRouter.delete('/keys/:id', (req, res) => {
    if (!db.prepare('DELETE FROM api_keys WHERE id=? AND user_id=?').run(req.params.id, req.user.id).changes) error('找不到 API key', 404);
    res.json({ ok: true });
  });
  app.use('/api', sessionAuth, accountRouter);
  app.use('/api', (_req, _res) => error('找不到此 API', 404));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? '伺服器發生錯誤，請稍後重試' : err.message });
  });
  return app;
}
