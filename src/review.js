import { questionTypes } from './question-types.js';
import { unpack } from './questions.js';

// Only auto-graded types have a "wrong" result; written answers are graded as null.
const reviewable = ['single', 'multiple'];

// Read-only: derives wrong questions from submitted attempts without changing any record.
// Returns the current bank version of each question so edits apply; questions deleted from the bank are skipped.
export function wrongQuestions(db, userId) {
  const attempts = db.prepare("SELECT questions_json,results_json FROM attempts WHERE user_id=? AND status='submitted' AND results_json IS NOT NULL ORDER BY submitted_at,id").all(userId);
  const history = new Map();
  for (const attempt of attempts) {
    const snapshots = new Map(JSON.parse(attempt.questions_json).map(q => [`${q.type}:${q.id}`, q]));
    for (const { key, correct } of JSON.parse(attempt.results_json)) {
      const q = snapshots.get(key);
      if (!q || !reviewable.includes(q.type) || typeof correct !== 'boolean') continue;
      // created_at tells a question apart from a later one that reused a deleted question's id.
      const identity = `${key}:${q.created_at}`;
      const entry = history.get(identity) ?? { type: q.type, id: q.id, createdAt: q.created_at, wrong: 0, lastCorrect: false };
      if (!correct) entry.wrong += 1;
      entry.lastCorrect = correct;
      history.set(identity, entry);
    }
  }
  const lookups = Object.fromEntries(reviewable.map(type => [type, db.prepare(`SELECT * FROM ${questionTypes[type].table} WHERE id=?`)]));
  return [...history.values()].filter(entry => entry.wrong > 0).flatMap(entry => {
    const row = lookups[entry.type].get(entry.id);
    return row && row.created_at === entry.createdAt ? [{ question: unpack(row, entry.type), wrong: entry.wrong, lastCorrect: entry.lastCorrect }] : [];
  });
}

export function reviewCatalog(items) {
  const groups = new Map();
  for (const { question: q, lastCorrect } of items) {
    const chapters = groups.get(q.subject) ?? new Map();
    const counts = chapters.get(q.chapter) ?? { total: 0, pending: 0 };
    counts.total += 1; if (!lastCorrect) counts.pending += 1;
    chapters.set(q.chapter, counts); groups.set(q.subject, chapters);
  }
  return {
    total: items.length,
    pending: items.filter(item => !item.lastCorrect).length,
    chapterGroups: [...groups.keys()].sort().map(subject => ({ subject, chapters: [...groups.get(subject).keys()].sort().map(chapter => ({ chapter, ...groups.get(subject).get(chapter) })) })),
  };
}
