import { openDatabase, transaction } from '../src/db.js';
import { questionTypes } from '../src/question-types.js';
import { createAccount, passwordHash, issueKey } from '../src/auth.js';

async function readPassword() {
  if (process.env.ACCOUNT_PASSWORD) return process.env.ACCOUNT_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('請在互動式終端輸入密碼，或透過 ACCOUNT_PASSWORD 環境變數提供');
  const read = prompt => new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    let value = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const finish = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', input); process.stdout.write('\n'); };
    const input = chunk => { for (const char of chunk) {
      if (char === '\u0003') { finish(); reject(new Error('已取消')); return; }
      if (char === '\r' || char === '\n') { finish(); resolve(value); return; }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else value += char;
    } };
    process.stdin.on('data', input);
  });
  const password = await read('密碼（輸入不顯示）：');
  if (password !== await read('再次輸入密碼：')) throw new Error('兩次密碼不一致');
  return password;
}
const [command, username, argument] = process.argv.slice(2);
const usage = `用法：npm run account -- <指令> [帳號] [參數]
  create <帳號>                 建立帳號（互動式輸入密碼）
  password <帳號>               覆蓋密碼並撤銷所有登入 session
  delete <帳號> --confirm       刪除帳號與其全部題庫、紀錄、API keys
  list                         列出帳號
  key-create <帳號> [標籤]      建立 API key（完整 key 只顯示一次）
  key-list <帳號>               列出 API keys（不顯示完整 key）
  key-revoke <帳號> <key ID>    撤銷 API key`;
let db;
try {
  if (!['create', 'password', 'delete', 'list', 'key-create', 'key-list', 'key-revoke'].includes(command)) throw new Error(usage);
  db = openDatabase();
  if (command === 'list') console.table(db.prepare('SELECT id,username,created_at FROM users').all());
  else if (command === 'create') { createAccount(db, username, await readPassword()); console.log(`已建立帳號 ${username}`); }
  else {
    const user = db.prepare('SELECT id FROM users WHERE username=?').get(username || '');
    if (!user) throw new Error('找不到帳號');
    if (command === 'password') {
      const hash = passwordHash(await readPassword());
      transaction(db, () => { db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); });
      console.log('密碼已覆蓋，所有登入 session 已撤銷。API keys 維持有效，可用 key-revoke 另外撤銷。');
    }
    if (command === 'delete') {
      if (argument !== '--confirm') throw new Error('刪除會永久移除該帳號的作答紀錄與 API keys；請加上 --confirm');
      // Questions are shared, so hand them to another account instead of cascading the delete.
      const heir = db.prepare('SELECT id FROM users WHERE id<>? ORDER BY id LIMIT 1').get(user.id);
      transaction(db, () => {
        if (heir) for (const { table } of Object.values(questionTypes)) db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id=?`).run(heir.id, user.id);
        db.prepare('DELETE FROM users WHERE id=?').run(user.id);
      });
      console.log(`已刪除 ${username}${heir ? '；題庫題目保留' : '；這是最後一個帳號，題庫已一併刪除'}`);
    }
    if (command === 'key-create') { const key = issueKey(db, user.id, argument || 'AI'); console.log(`API key ID：${key.id}\n請立即安全保存，完整 key 只顯示一次：\n${key.token}`); }
    if (command === 'key-list') console.table(db.prepare('SELECT id,label,prefix,created_at FROM api_keys WHERE user_id=?').all(user.id));
    if (command === 'key-revoke') { if (!db.prepare('DELETE FROM api_keys WHERE user_id=? AND id=?').run(user.id, Number(argument) || 0).changes) throw new Error('找不到 API key'); console.log('API key 已撤銷'); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); }
