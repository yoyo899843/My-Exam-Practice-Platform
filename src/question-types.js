// Register new types here. Table names are trusted code, never user input.
const choices = (multiple) => ({
  validate(q, fail) {
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 12 || q.options.some(x => typeof x !== 'string' || !x.trim() || x.length > 5000)) fail('選擇題需要 2–12 個非空白選項');
    const valid = x => Number.isInteger(x) && x >= 0 && x < q.options.length;
    if (multiple ? !Array.isArray(q.answer) || !q.answer.length || !q.answer.every(valid) || new Set(q.answer).size !== q.answer.length : !valid(q.answer)) fail('答案必須是有效的選項索引（從 0 開始）');
  },
  validateResponse(value, q) {
    const valid = x => Number.isInteger(x) && x >= 0 && x < q.options.length;
    return value === null || (multiple ? Array.isArray(value) && value.every(valid) && new Set(value).size === value.length : valid(value));
  },
  grade(value, q) {
    return multiple ? Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify([...q.answer].sort()) : value === q.answer;
  },
});
const written = {
  validate(q, fail) { if (typeof q.answer !== 'string' || !q.answer.trim() || q.answer.length > 50000) fail('參考答案必須是非空白文字（最多 50,000 字）'); q.options = []; },
  validateResponse: value => value === null || typeof value === 'string' && value.length <= 50000,
  grade: () => null,
};
export const questionTypes = {
  single: { label: '單選題', table: 'single_questions', ...choices(false) },
  multiple: { label: '多選題', table: 'multiple_questions', ...choices(true) },
  short: { label: '簡答題', table: 'short_questions', ...written },
  essay: { label: '申論題', table: 'essay_questions', ...written },
};
export function typeFor(type) {
  if (!Object.hasOwn(questionTypes, type)) throw Object.assign(new Error('不支援的題目類型'), { status: 400 });
  return questionTypes[type];
}
export function validateQuestion(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object') fail('題目格式錯誤');
  const q = { ...input };
  const type = typeFor(q.type);
  for (const field of ['subject', 'chapter', 'question', 'answer', 'explanation', 'language']) if (!(field in q)) fail(`缺少欄位：${field}`);
  for (const field of ['subject', 'chapter', 'question', 'explanation', 'language']) {
    if (typeof q[field] !== 'string' || !q[field].trim() || q[field].length > (['question', 'explanation'].includes(field) ? 50000 : 200)) fail(`欄位 ${field} 必須是非空白文字且不可超過長度限制`);
    q[field] = q[field].trim();
  }
  type.validate(q, fail);
  return q;
}
