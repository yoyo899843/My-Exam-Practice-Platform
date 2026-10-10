import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
const settings = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('密碼需為 8–1024 個字元');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64, settings).toString('hex')}`;
}
export async function checkPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const [salt, expected] = hash.split(':');
  const result = await derive(password, salt, 64, settings);
  return timingSafeEqual(result, Buffer.from(expected, 'hex'));
}
export function createAccount(db, username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) throw new Error('帳號需為 3–64 個英數字或 _ . -');
  return Number(db.prepare('INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)').run(username, passwordHash(password), new Date().toISOString()).lastInsertRowid);
}
export function issueKey(db, userId, label = 'AI') {
  const token = `pk_${newToken()}`;
  const id = Number(db.prepare('INSERT INTO api_keys(user_id,key_hash,label,prefix,created_at) VALUES(?,?,?,?,?)').run(userId, hashToken(token), label, token.slice(0, 11), new Date().toISOString()).lastInsertRowid);
  return { id, token };
}
