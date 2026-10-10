const root = document.querySelector('#app');
const modal = document.querySelector('#modal');
const typeLabels = { single: '單選題', multiple: '多選題', short: '簡答題', essay: '申論題' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const duration = seconds => `${Math.floor(seconds / 3600) ? String(Math.floor(seconds / 3600)).padStart(2, '0') + ':' : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const date = value => new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
let user, catalog, activeAttempt, index = 0, bankPage = 1, bankFilter = {}, timer, saveDelay, saveQueue = Promise.resolve(), dirty = false, toastTimer;
let renderId = 0;
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 4500); }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'PracticeRoom', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') { user = null; clearInterval(timer); loginPage(); }
    throw new Error(data.error || '請求失敗');
  }
  return data;
}
const options = (values, selected, all = '全部') => `<option value="">${all}</option>${values.map(v => `<option value="${escape(v)}" ${v === selected ? 'selected' : ''}>${escape(v)}</option>`).join('')}`;
function shell(page) {
  const nav = [['home', '首頁'], ['practice', '練習'], ['bank', '題庫'], ['history', '紀錄']];
  root.innerHTML = `<header class="topbar"><nav aria-label="主要導覽">${nav.map(([key, text]) => `<button class="nav-button ${page === key ? 'active' : ''}" data-page="${key}" ${page === key ? 'aria-current="page"' : ''}>${text}</button>`).join('')}</nav><div class="row"><span>${escape(user.username)}</span><button data-action="logout">登出</button></div></header><main class="page" id="main"><div id="content"><p class="muted">載入中…</p></div></main>`;
}
function loginPage() {
  root.innerHTML = `<main class="login" id="main"><h1>登入</h1><form id="login-form" class="stack"><label>帳號<input name="username" autocomplete="username" required maxlength="64" autofocus></label><div><label for="login-password">密碼</label><div class="password-field"><input id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="button" data-action="toggle-password" aria-controls="login-password" aria-pressed="false" aria-label="顯示密碼">顯示</button></div></div><div class="form-error" role="alert" id="login-error"></div><button class="primary" type="submit">登入</button></form></main>`;
  document.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('[type=submit]'); button.disabled = true; button.textContent = '登入中…';
    try { user = await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(event.target)) }); location.hash = 'home'; await navigate('home'); }
    catch (error) { const field = document.querySelector('#login-error'); if (field) field.textContent = error.message; else toast(error.message); button.disabled = false; button.textContent = '登入'; }
  });
}
function heading(title, action = '') { return `<div class="row between page-heading"><h1 tabindex="-1">${title}</h1>${action}</div>`; }
function recordRows(records) {
  return records.map(a => `<div class="record"><div><strong>${escape(a.title)}</strong>${a.status === 'active' ? ' <span class="muted">（作答中）</span>' : ''}<div class="small muted">${date(a.started_at)} · ${a.count} 題${a.status === 'submitted' ? ` · ${duration(a.duration_seconds)}${a.graded ? ` · 答對 ${a.correct} / ${a.graded}` : ''}` : ''}</div></div><button data-action="open-attempt" data-id="${a.id}">${a.status === 'active' ? '繼續' : '查看'}</button></div>`).join('');
}
async function home(id) {
  const [c, stats, records] = await Promise.all([api('/catalog'), api('/stats'), api('/attempts')]);
  if (id !== renderId) return;
  catalog = c;
  document.querySelector('#content').innerHTML = `${heading('首頁', '<button class="primary" data-page="practice">開始練習</button>')}<p>題目 ${c.total} 題（${Object.entries(typeLabels).map(([type, label]) => `${label} ${c.counts[type]}`).join('、')}）</p><p>完成 ${stats.completed} 次 · 作答 ${stats.answered} 題 · ${Math.floor(stats.seconds / 60)} 分鐘${stats.accuracy === null ? '' : ` · 選擇題正確率 ${stats.accuracy}%`}</p><h2>最近紀錄</h2>${records.length ? recordRows(records.slice(0, 3)) : '<p class="muted">尚無紀錄</p>'}`;
}
async function practice(id) {
  catalog = await api('/catalog'); if (id !== renderId) return;
  document.querySelector('#content').innerHTML = `${heading('練習')}<form id="practice-form" class="stack"><div class="filters"><label>科目<select name="subject">${options(catalog.subjects, '')}</select></label><label>章節<select name="chapter">${options(catalog.chapters, '')}</select></label><label>語言<select name="language">${options(catalog.languages, '')}</select></label></div><div>${Object.entries(typeLabels).map(([type, label]) => `<div class="count-row"><span>${label}（可用 <span id="available-${type}">${catalog.counts[type]}</span> 題）</span><input type="number" name="${type}" aria-label="${label}題數" value="0" min="0" max="${Math.min(100, catalog.counts[type])}" step="1" inputmode="numeric"></div>`).join('')}</div><p>共 <span id="total-count">0</span> 題</p><div class="form-error" id="practice-error" role="alert"></div><div><button class="primary" id="start-button" disabled>開始</button></div></form>`;
  const form = document.querySelector('#practice-form');
  const total = () => { const count = Object.keys(typeLabels).reduce((n, t) => n + Number(form.elements[t].value || 0), 0); document.querySelector('#total-count').textContent = count; document.querySelector('#start-button').disabled = count < 1 || count > 200; };
  form.addEventListener('input', total);
  let filterVersion = 0;
  form.addEventListener('change', async event => {
    if (!['subject', 'chapter', 'language'].includes(event.target.name)) return;
    const version = ++filterVersion;
    document.querySelector('#start-button').disabled = true;
    if (event.target.name === 'subject') form.elements.chapter.value = '';
    try {
      const query = new URLSearchParams(Object.fromEntries(['subject', 'chapter', 'language'].map(k => [k, form.elements[k].value])));
      const c = await api(`/catalog?${query}`); if (version !== filterVersion || !form.isConnected) return;
      if (event.target.name === 'subject') form.elements.chapter.innerHTML = options(c.chapters, '');
      for (const type of Object.keys(typeLabels)) { const el = form.elements[type]; const max = Math.min(100, c.counts[type]); el.max = max; el.value = Math.min(Number(el.value), max); document.querySelector(`#available-${type}`).textContent = c.counts[type]; }
      total();
    } catch (error) { toast(error.message); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = document.querySelector('#start-button'); button.disabled = true;
    try { const values = Object.fromEntries(new FormData(form)); const counts = Object.fromEntries(Object.keys(typeLabels).map(t => [t, Number(values[t])])); const a = await api('/attempts', { method: 'POST', body: { counts, subject: values.subject, chapter: values.chapter, language: values.language } }); location.hash = `attempt/${a.id}`; }
    catch (error) { document.querySelector('#practice-error').textContent = error.message; total(); }
  });
}
async function bank(id) {
  const query = new URLSearchParams({ ...bankFilter, page: bankPage, limit: 10 });
  const [c, data] = await Promise.all([api('/catalog'), api(`/questions?${query}`)]); if (id !== renderId) return;
  catalog = c;
  document.querySelector('#content').innerHTML = `${heading('題庫', '<button class="primary" data-action="new-question">新增</button>')}<div class="toolbar"><button data-action="import-csv">匯入 CSV</button><button data-action="export-csv">匯出 CSV</button><button data-action="api-help">API</button></div><form id="bank-filter" class="toolbar"><input name="search" aria-label="搜尋題目" placeholder="搜尋" value="${escape(bankFilter.search)}"><select name="type" aria-label="依題型篩選">${options(Object.keys(typeLabels), bankFilter.type, '所有題型').replace(/>(single|multiple|short|essay)</g, (_m, t) => `>${typeLabels[t]}<`)}</select><select name="subject" aria-label="依科目篩選">${options(c.subjects, bankFilter.subject, '所有科目')}</select><button type="submit">搜尋</button></form><p class="small muted">${data.total} 題</p>${data.questions.length ? data.questions.map(q => `<div class="question-row"><div><div class="small muted">${typeLabels[q.type]} · ${escape(q.subject)} / ${escape(q.chapter)} · ${escape(q.language)}</div><div>${escape(q.question.length > 150 ? q.question.slice(0, 150) + '…' : q.question)}</div></div><div class="row"><button data-action="edit-question" data-type="${q.type}" data-id="${q.id}">編輯</button><button class="danger" data-action="delete-question" data-type="${q.type}" data-id="${q.id}" aria-label="刪除這道題目">刪除</button></div></div>`).join('') : `<p class="muted">沒有題目${c.total ? ` <button data-action="clear-filter">清除篩選</button>` : ''}</p>`}<div class="row between pagination"><span class="small muted">${bankPage} / ${Math.max(1, Math.ceil(data.total / 10))}</span><div class="row"><button data-action="bank-prev" ${bankPage <= 1 ? 'disabled' : ''}>上一頁</button><button data-action="bank-next" ${bankPage * 10 >= data.total ? 'disabled' : ''}>下一頁</button></div></div>`;
  document.querySelector('#bank-filter').addEventListener('submit', event => { event.preventDefault(); bankFilter = Object.fromEntries(new FormData(event.target)); bankPage = 1; navigate('bank'); });
}
async function history(id) {
  const records = await api('/attempts'); if (id !== renderId) return;
  document.querySelector('#content').innerHTML = `${heading('紀錄')}${records.length ? recordRows(records) : '<p class="muted">尚無紀錄</p>'}`;
}

function openModal(title, content, actions = '') {
  modal.setAttribute('aria-labelledby', 'modal-title');
  modal.innerHTML = `<div class="modal-header"><h2 id="modal-title">${title}</h2><button data-action="close-modal" aria-label="關閉視窗">×</button></div>${content}${actions ? `<div class="modal-footer">${actions}</div>` : ''}`;
  if (!modal.open) modal.showModal();
}
async function questionEditor(type, id) {
  const q = id ? await api(`/questions/${type}/${id}`) : { type: 'single', subject: '', chapter: '', question: '', options: ['', ''], answer: 0, explanation: '', language: 'zh-TW' };
  const answerText = q.type === 'single' ? q.answer + 1 : q.type === 'multiple' ? q.answer.map(x => x + 1).join(', ') : q.answer;
  openModal(id ? '編輯題目' : '新增題目', `<form id="question-form" class="stack"><div class="grid2"><label>題目類型<select name="type" ${id ? 'disabled' : ''}>${Object.entries(typeLabels).map(([key, label]) => `<option value="${key}" ${q.type === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>語言<input name="language" value="${escape(q.language)}" required maxlength="200" placeholder="例如 zh-TW、en"></label><label>科目<input name="subject" value="${escape(q.subject)}" required maxlength="200"></label><label>章節<input name="chapter" value="${escape(q.chapter)}" required maxlength="200"></label></div><label>題目<textarea name="question" rows="3" required maxlength="50000">${escape(q.question)}</textarea></label><div id="options-label" class="stack"><span class="small">選項</span><div id="option-fields" class="stack"></div><button type="button" id="add-option">新增選項</button></div><label>正確／參考答案<span class="hint" id="answer-hint"></span><textarea name="answer" rows="3" required maxlength="50000">${escape(answerText)}</textarea></label><label>解析<textarea name="explanation" rows="4" required maxlength="50000">${escape(q.explanation)}</textarea></label><div id="question-error" class="form-error" role="alert"></div><div class="modal-footer"><button type="button" data-action="close-modal">取消</button><button class="primary" type="submit">儲存題目</button></div></form>`);
  const form = document.querySelector('#question-form');
  const optionFields = document.querySelector('#option-fields');
  const optionValues = () => [...optionFields.querySelectorAll('textarea')].map(el => el.value);
  const drawOptions = values => {
    optionFields.innerHTML = values.map((value, i) => `<div class="row" style="align-items:flex-end"><label style="flex:1">選項 ${i + 1}<textarea data-option="${i}" rows="2" maxlength="5000">${escape(value)}</textarea></label><button type="button" data-remove="${i}" aria-label="移除選項 ${i + 1}" ${values.length <= 2 ? 'disabled' : ''}>×</button></div>`).join('');
    document.querySelector('#add-option').disabled = values.length >= 12;
  };
  drawOptions(q.options.length ? q.options : ['', '']);
  document.querySelector('#add-option').addEventListener('click', () => drawOptions([...optionValues(), '']));
  optionFields.addEventListener('click', event => { const button = event.target.closest('[data-remove]'); if (button && !button.disabled) drawOptions(optionValues().filter((_v, i) => i !== Number(button.dataset.remove))); });
  const changeType = () => { const type = form.elements.type.value; document.querySelector('#options-label').hidden = !['single', 'multiple'].includes(type); document.querySelector('#answer-hint').textContent = type === 'single' ? '選項編號，例如 2' : type === 'multiple' ? '選項編號，以逗號分隔，例如 1, 3' : ''; };
  form.elements.type.addEventListener('change', changeType); changeType();
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true;
    const values = Object.fromEntries(new FormData(form)); values.type = form.elements.type.value;
    if (['single', 'multiple'].includes(values.type)) {
      values.options = optionValues().map(s => s.trim());
      const numbers = values.answer.trim().split(/[,，]/).map(s => s.trim());
      if (numbers.some(s => !/^\d+$/.test(s))) { document.querySelector('#question-error').textContent = '選擇題答案請填有效的選項編號'; button.disabled = false; return; }
      values.answer = values.type === 'single' && numbers.length === 1 ? Number(numbers[0]) - 1 : numbers.map(n => Number(n) - 1);
    } else values.options = [];
    try { await api(id ? `/questions/${type}/${id}` : '/questions', { method: id ? 'PUT' : 'POST', body: values }); modal.close(); toast('題目已儲存'); await navigate('bank'); }
    catch (error) { document.querySelector('#question-error').textContent = error.message; button.disabled = false; }
  });
}
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importDialog() {
  openModal('匯入 CSV', `<p><button data-action="csv-template">下載範例 CSV</button></p><form id="import-form" class="stack"><label>CSV 檔案<input type="file" name="csv" accept=".csv,text/csv" required></label><div id="import-error" class="form-error" role="alert"></div><div class="modal-footer"><button type="button" data-action="close-modal">取消</button><button class="primary" type="submit">匯入</button></div></form>`);
  document.querySelector('#import-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target; const button = form.querySelector('[type=submit]'); button.disabled = true;
    try { const file = form.elements.csv.files[0]; if (file.size > 4 * 1024 * 1024) throw new Error('CSV 檔案請小於 4 MB'); const data = await api('/questions/import', { method: 'POST', body: { csv: await file.text() } }); modal.close(); toast(`已匯入 ${data.imported} 題`); bankPage = 1; await navigate('bank'); }
    catch (error) { document.querySelector('#import-error').textContent = error.message; button.disabled = false; }
  });
}
function apiHelp() {
  const payload = { questions: [{ type: 'single', subject: '計算機概論', chapter: '資料庫', question: 'SQLite 屬於哪一種資料庫？', options: ['關聯式資料庫', '圖形資料庫'], answer: 0, explanation: 'SQLite 使用資料表與 SQL 儲存及查詢資料。', language: 'zh-TW' }] };
  openModal('API', `<div class="stack"><div><div class="code">POST ${escape(location.origin)}/api/v1/questions/bulk\nX-API-Key: 你的 API key\nContent-Type: application/json</div></div><div><pre class="code">${escape(JSON.stringify(payload, null, 2))}</pre></div><p class="small muted">type：single、multiple、short、essay。每批最多 2,000 題。</p></div>`);
}

const keyFor = q => `${q.type}:${q.id}`;
function questionNavigation(questions) {
  const pages = [...new Set([0, index - 1, index, index + 1, questions.length - 1])].filter(i => i >= 0 && i < questions.length).sort((a, b) => a - b);
  return pages.map((i, position) => {
    const answered = hasAnswer(questions[i]);
    const gap = position > 0 && i - pages[position - 1] > 1 ? '<span aria-hidden="true">…</span>' : '';
    return `${gap}<button class="dot ${answered ? 'answered' : ''} ${i === index ? 'current' : ''}" data-action="exam-page" data-index="${i}" aria-label="第 ${i + 1} 題${answered ? '，已作答' : '，未作答'}" ${i === index ? 'aria-current="page"' : ''}>${i + 1}${answered ? '<span class="mark">✓</span>' : ''}</button>`;
  }).join('');
}
function hasAnswer(q) { const value = activeAttempt.answers[keyFor(q)]; return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && String(value).trim() !== ''; }
function answerDisplay(value, q) {
  if (value === null || value === undefined || value === '' || Array.isArray(value) && !value.length) return '（未作答）';
  if (q.type === 'single') return `${String.fromCharCode(65 + value)}. ${q.options[value]}`;
  if (q.type === 'multiple') return [...value].sort().map(i => `${String.fromCharCode(65 + i)}. ${q.options[i]}`).join('\n');
  return value;
}
async function loadAttempt(attemptId, id) {
  const a = await api(`/attempts/${attemptId}`); if (id !== renderId) return;
  activeAttempt = a; index = a.status === 'active' ? a.current_index : 0; dirty = false;
  renderExam();
  if (a.status === 'active') timer = setInterval(updateTimer, 1000);
}
function updateTimer() { const el = document.querySelector('#timer'); if (el) el.textContent = duration(Math.max(0, Math.floor((Date.now() - Date.parse(activeAttempt.started_at)) / 1000))); }
function renderExam() {
  const a = activeAttempt, q = a.questions[index], review = a.status === 'submitted';
  const answered = a.questions.filter(hasAnswer).length;
  const result = a.results?.find(r => r.key === keyFor(q));
  const graded = a.results?.filter(r => r.correct !== null) || [];
  const correct = graded.filter(r => r.correct).length;
  root.innerHTML = `<main class="exam" id="main"><header class="exam-header"><span class="timer" id="timer">${review ? duration(a.duration_seconds) : '00:00'}</span><div class="row">${review ? '<button data-page="history">返回</button>' : `<button data-action="leave-attempt">稍後繼續</button><button class="primary" data-action="submit-attempt">交卷</button>`}</div></header><section class="exam-main"><div class="exam-content">${review ? `<div class="review-meta row between"><span>已交卷${graded.length ? ` · 答對 ${correct} / ${graded.length}` : ''}</span><span class="small muted">${date(a.submitted_at)}</span></div>` : ''}<div class="row between"><span class="small muted">${typeLabels[q.type]} · ${escape(q.subject)} / ${escape(q.chapter)}</span><label class="question-picker"><span class="sr-only">跳至題目</span><select id="question-jump">${a.questions.map((_q, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>第 ${i + 1} / ${a.questions.length} 題</option>`).join('')}</select></label></div><h1 class="pre" tabindex="-1" id="question-heading">${escape(q.question)}</h1>${review ? `<div class="row">${result.correct === null ? '' : `<span class="${result.correct ? '' : 'danger'}">${result.correct ? '正確' : '錯誤'}</span>`}<button data-action="explanation">解析</button></div><div class="answer-box"><h2>你的答案</h2><p class="pre">${escape(answerDisplay(a.answers[keyFor(q)], q))}</p></div><div class="answer-box"><h2>${result.correct === null ? '參考答案' : '正確答案'}</h2><p class="pre">${escape(answerDisplay(q.answer, q))}</p></div>` : ['single', 'multiple'].includes(q.type) ? `${q.type === 'multiple' ? '<p class="small muted">複選</p>' : ''}<fieldset class="option-list" style="border:0;padding:0"><legend class="sr-only">答案選項</legend>${q.options.map((option, i) => `<label class="option"><input type="${q.type === 'single' ? 'radio' : 'checkbox'}" name="answer" value="${i}" ${q.type === 'single' ? a.answers[keyFor(q)] === i ? 'checked' : '' : a.answers[keyFor(q)]?.includes(i) ? 'checked' : ''}><span>${String.fromCharCode(65 + i)}</span><span class="option-text">${escape(option)}</span></label>`).join('')}</fieldset>` : `<label>你的答案<textarea class="written-answer" id="written-answer" name="answer" maxlength="50000">${escape(a.answers[keyFor(q)] || '')}</textarea></label>`}</div></section><footer class="exam-footer"><div class="exam-footer-inner"><div><div class="row between" style="margin-bottom:10px"><span class="small muted" id="answered-count">${review ? '' : `已作答 ${answered} / ${a.questions.length}`}</span>${review ? '' : `<span class="saving" id="save-status" role="status">${dirty ? '未儲存' : '已儲存'}</span>`}</div><nav class="question-dots" aria-label="題目導覽">${questionNavigation(a.questions)}</nav></div><div class="row"><button data-action="exam-prev" ${index === 0 ? 'disabled' : ''}>上一題</button><button class="primary" data-action="exam-next" ${index === a.questions.length - 1 ? 'disabled' : ''}>下一題</button></div></div></footer></main>`;
  document.querySelector('#question-jump').addEventListener('change', event => { examPage(Number(event.target.value)).catch(error => toast(error.message)); });
  if (!review) {
    updateTimer();
    root.querySelectorAll('[name=answer]').forEach(input => input.addEventListener('input', () => {
      const value = q.type === 'single' ? Number(root.querySelector('[name=answer]:checked').value) : q.type === 'multiple' ? [...root.querySelectorAll('[name=answer]:checked')].map(x => Number(x.value)) : input.value;
      a.answers[keyFor(q)] = value; dirty = true;
      const status = document.querySelector('#save-status'); if (status) status.textContent = '儲存中…';
      const dot = document.querySelector(`[data-index="${index}"]`); dot?.classList.toggle('answered', hasAnswer(q));
      const count = a.questions.filter(hasAnswer).length; document.querySelector('#answered-count').textContent = `已作答 ${count} / ${a.questions.length}`;
      if (hasAnswer(q) && dot && !dot.querySelector('.mark')) dot.insertAdjacentHTML('beforeend', '<span class="mark">✓</span>');
      if (!hasAnswer(q)) dot?.querySelector('.mark')?.remove();
      dot?.setAttribute('aria-label', `第 ${index + 1} 題，${hasAnswer(q) ? '已作答' : '未作答'}`);
      clearTimeout(saveDelay); saveDelay = setTimeout(() => { saveProgress().catch(error => toast(error.message)); }, 450);
    }));
  }
}
async function saveProgress() {
  clearTimeout(saveDelay);
  if (!activeAttempt || activeAttempt.status !== 'active') return;
  const attempt = activeAttempt, snapshot = JSON.stringify(attempt.answers), at = index;
  const perform = async () => {
    try {
      await api(`/attempts/${attempt.id}`, { method: 'PATCH', body: { answers: JSON.parse(snapshot), current_index: at } });
      if (activeAttempt === attempt && JSON.stringify(attempt.answers) === snapshot) { dirty = false; const el = document.querySelector('#save-status'); if (el) el.textContent = '已儲存'; }
    } catch (error) { const el = document.querySelector('#save-status'); if (el) el.textContent = '儲存失敗'; throw error; }
  };
  saveQueue = saveQueue.catch(() => {}).then(perform);
  return saveQueue;
}
async function examPage(next) {
  index = Math.max(0, Math.min(activeAttempt.questions.length - 1, next));
  renderExam(); document.querySelector('#question-heading')?.focus({ preventScroll: true });
  if (activeAttempt.status === 'active') await saveProgress();
}
function submitDialog() {
  const answered = activeAttempt.questions.filter(hasAnswer).length, count = activeAttempt.questions.length;
  openModal('交卷？', `<p>已作答 ${answered} / ${count} 題。</p>`, '<button data-action="close-modal">取消</button><button class="primary" data-action="confirm-submit">交卷</button>');
}
async function navigate(page) {
  const id = ++renderId; clearInterval(timer);
  if (!user) return;
  if (page.startsWith('attempt/')) { root.innerHTML = '<p class="page muted">載入中…</p>'; await loadAttempt(page.slice(8), id); return; }
  activeAttempt = null; shell(['home', 'practice', 'bank', 'history'].includes(page) ? page : 'home');
  await ({ home, practice, bank, history }[page] || home)(id);
  if (id === renderId && document.activeElement === document.body) document.querySelector('#content h1')?.focus({ preventScroll: true });
}
async function route(page) { if (activeAttempt?.status === 'active') await saveProgress(); if (location.hash.slice(1) === page) await navigate(page); else location.hash = page; }
root.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.page) { try { await route(button.dataset.page); } catch (error) { toast(error.message); } return; }
  await handleAction(button);
});
modal.addEventListener('click', async event => { const button = event.target.closest('button[data-action]'); if (button && !button.disabled) await handleAction(button); });
async function handleAction(button) {
  const { action, type, id } = button.dataset;
  try {
    if (action === 'close-modal') modal.close();
    if (action === 'toggle-password') {
      const input = document.querySelector('#login-password');
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.textContent = visible ? '隱藏' : '顯示';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', visible ? '隱藏密碼' : '顯示密碼');
    }
    if (action === 'logout') { if (activeAttempt?.status === 'active') await saveProgress(); await api('/logout', { method: 'POST' }); user = null; clearInterval(timer); loginPage(); }
    if (action === 'new-question') await questionEditor();
    if (action === 'edit-question') await questionEditor(type, id);
    if (action === 'delete-question') {
      openModal('刪除題目？', '<p>無法還原。</p>', `<button data-action="close-modal">取消</button><button class="danger" data-action="confirm-delete" data-type="${type}" data-id="${id}">刪除</button>`);
    }
    if (action === 'confirm-delete') { button.disabled = true; await api(`/questions/${type}/${id}`, { method: 'DELETE' }); modal.close(); toast('題目已刪除'); bankPage = 1; await navigate('bank'); }
    if (action === 'clear-filter') { bankFilter = {}; bankPage = 1; await navigate('bank'); }
    if (action === 'bank-prev' || action === 'bank-next') { bankPage += action === 'bank-next' ? 1 : -1; await navigate('bank'); }
    if (action === 'import-csv') importDialog();
    if (action === 'api-help') apiHelp();
    if (action === 'export-csv') {
      const response = await fetch(`/api/questions/export?${new URLSearchParams(bankFilter)}`); if (!response.ok) throw new Error('匯出失敗，請確認登入狀態'); download(await response.text(), 'questions.csv'); toast('已匯出');
    }
    if (action === 'csv-template') { const response = await fetch('/example-questions.csv'); download(await response.text(), 'example-questions.csv'); }
    if (action === 'open-attempt') await route(`attempt/${id}`);
    if (action === 'leave-attempt') { await saveProgress(); await route('history'); }
    if (action === 'exam-page') await examPage(Number(button.dataset.index));
    if (action === 'exam-prev') await examPage(index - 1);
    if (action === 'exam-next') await examPage(index + 1);
    if (action === 'submit-attempt') submitDialog();
    if (action === 'confirm-submit') {
      button.disabled = true; await saveProgress();
      activeAttempt = await api(`/attempts/${activeAttempt.id}/submit`, { method: 'POST', body: { answers: activeAttempt.answers } });
      dirty = false; clearInterval(timer); modal.close(); index = 0; renderExam(); toast('已交卷');
    }
    if (action === 'explanation') { const q = activeAttempt.questions[index]; openModal('解析', `<div class="pre">${escape(q.explanation)}</div>`); }
  } catch (error) { button.disabled = false; toast(error.message); }
}
window.addEventListener('hashchange', async () => {
  try { if (activeAttempt?.status === 'active') await saveProgress(); await navigate(location.hash.slice(1) || 'home'); }
  catch (error) { toast(error.message); }
});
window.addEventListener('beforeunload', event => { if (dirty && activeAttempt?.status === 'active') { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', () => { if (dirty) saveProgress().catch(error => toast(error.message)); });
document.addEventListener('keydown', event => { if (!activeAttempt || modal.open || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return; if (event.key === 'ArrowRight') examPage(index + 1).catch(error => toast(error.message)); if (event.key === 'ArrowLeft') examPage(index - 1).catch(error => toast(error.message)); });
try { user = await api('/me'); await navigate(location.hash.slice(1) || 'home'); }
catch (error) { if (!user) loginPage(); else toast(error.message); }
