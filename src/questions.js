import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { questionTypes, typeFor, validateQuestion } from './question-types.js';
import { transaction } from './db.js';
export const fields = ['type', 'subject', 'chapter', 'question', 'options', 'answer', 'explanation', 'language'];
export function unpack(row, type) { return { ...row, type, answer: JSON.parse(row.answer), options: JSON.parse(row.options) }; }
// The question bank is shared by all accounts; user_id only records who created a question.
export function allQuestions(db, filter = {}) {
  const types = filter.type ? [[filter.type, typeFor(filter.type)]] : Object.entries(questionTypes);
  return types.flatMap(([type, { table }]) => {
    const params = [];
    let where = '1=1';
    for (const field of ['subject', 'chapter', 'language']) {
      const values = [filter[field]].flat().filter(v => typeof v === 'string' && v);
      if (values.length) { where += ` AND ${field} IN (${values.map(() => '?').join(',')})`; params.push(...values); }
    }
    return db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id DESC`).all(...params).map(row => unpack(row, type));
  }).filter(q => !filter.search || [q.subject, q.chapter, q.question].some(x => x.toLowerCase().includes(filter.search.toLowerCase())));
}
export function insertQuestion(db, userId, input) {
  const q = validateQuestion(input);
  const now = new Date().toISOString();
  const id = Number(db.prepare(`INSERT INTO ${typeFor(q.type).table}(user_id,subject,chapter,question,answer,explanation,language,options,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(userId, q.subject, q.chapter, q.question, JSON.stringify(q.answer), q.explanation, q.language, JSON.stringify(q.options), now, now).lastInsertRowid);
  return { ...q, id };
}
export function importQuestions(db, userId, inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 2000) throw Object.assign(new Error('每批需為 1–2,000 題'), { status: 400 });
  const valid = inputs.map((q, i) => { try { return validateQuestion(q); } catch (error) { error.message = `第 ${i + 1} 題：${error.message}`; throw error; } });
  return transaction(db, () => valid.map(q => insertQuestion(db, userId, q)));
}
export function parseCsv(csv) {
  try {
    if (typeof csv !== 'string' || !csv.trim()) throw new Error('CSV 不可空白');
    const rows = parse(csv, { bom: true, columns: header => {
      if (fields.some(f => !header.includes(f)) || new Set(header).size !== header.length) throw new Error(`欄位需包含 ${fields.join(',')}`);
      return header;
    }, skip_empty_lines: true, max_record_size: 250000 });
    return rows.map((row, i) => {
      try {
        for (const key of fields) if (/^'[=+@\-\t\r]/.test(row[key])) row[key] = row[key].slice(1);
        return { ...row, options: JSON.parse(row.options || '[]'), answer: JSON.parse(row.answer) };
      } catch { throw new Error(`第 ${i + 1} 列的 options 或 answer 不是有效 JSON`); }
    });
  } catch (error) { throw Object.assign(new Error(`CSV 格式錯誤：${error.message}`), { status: 400 }); }
}
export function exportCsv(questions) {
  const safe = value => /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return '\uFEFF' + stringify(questions.map(q => Object.fromEntries(fields.map(f => [f, safe(['options', 'answer'].includes(f) ? JSON.stringify(q[f]) : q[f])]))), { header: true, columns: fields });
}
