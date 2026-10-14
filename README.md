# 練習室 · 個人題庫與練習平台

Node.js 24 + Express + SQLite，搭配無需建置的原生 JavaScript 介面。SQLite 使用 Node 內建的 `node:sqlite`；在 Node 24 上可能出現實驗性 API 提示，請使用 Node 24 最新維護版本。

## 本機啟動

```sh
npm install
cp .env.example .env
npm run account -- create yourname
npm start
```

開啟 <http://127.0.0.1:3000>，在登入頁點「註冊」自行設定帳號與密碼（密碼輸入兩次），註冊後直接登入；也可以用上面的 script 建立帳號，輸入不會顯示。帳號為 3–64 個英數字或 `_ . -`，密碼須為 8–1024 個字元。沒有預設帳號，也沒有密碼重設入口；同一 IP 每小時最多註冊 10 次。

註冊是公開的，而題庫由所有帳號共用，任何能連到網站的人都能註冊並編輯題庫；放到外網前請留意。

題库初始為空，可在「題庫」頁手動新增，或匯入 [四種題型的 CSV 範例](public/example-questions.csv)。`npm run dev` 可在伺服器程式修改時自動重啟。

## 帳號與 API keys

登入後在「帳號」頁可以產生、查看及撤銷自己的 API keys（只能用登入 cookie 操作，API key 本身不能產生新 key）。建立帳號、改密碼與刪除帳號仍需用 script：

```sh
npm run account -- list
npm run account -- create yourname
npm run account -- password yourname
npm run account -- key-create yourname AI
npm run account -- key-list yourname
npm run account -- key-revoke yourname 1
npm run account -- delete yourname --confirm
```

`password` 直接覆蓋密碼，並撤銷該帳號的全部登入 session；API keys 可另外撤銷。網頁與 script 產生的完整 API key 都只在建立時顯示一次，資料庫只保存雜湊。每個帳號可以有多把 key。

`delete --confirm` 會永久刪除該帳號的作答紀錄、登入 session 與 API keys；題庫是共用的，該帳號建立的題目會保留（刪除最後一個帳號時題庫才會一併刪除）。自動化環境可以透過 `ACCOUNT_PASSWORD` 環境變數提供密碼，請勿把密碼放進指令參數或提交至 Git。

## 題庫與練習

- 四種題型各有獨立資料表，共同欄位為科目、章節、題目、答案、解析、語言；選擇題另有選項欄位。
- 題庫由所有帳號共用，任何帳號都能新增、編輯與刪除題目；作答紀錄與 API keys 則各帳號分開。支援搜尋、題型與科目篩選、逐題編輯、刪除及 CSV 匯入匯出。
- 可依科目、章節（可複選）與語言設定範圍，再指定每種題型的題數。每種最多 100 題，單次最多 200 題，隨機抽取且不重複。
- 作答採每題一頁，可點題號，或使用上一題／下一題、鍵盤左右方向鍵。題號列最多顯示五個按鈕，也可用題目旁的下拉選單跳到任意題。作答頁固定在視窗內；遇到超長題目或小螢幕時，題目區可獨立捲動，避免截斷內容。
- 答案在輸入後約 450 毫秒保存到 SQLite，翻頁及離開練習前也會保存。儲存失敗會顯示提示；重新連線後重試，尚未保存時關閉頁面會提示。
- 計時從建立練習至交卷，包括關閉分頁或「稍後繼續」的時間；不提供暫停。交卷時間與用時由伺服器計算。
- 單選題自動批改；多選題需選取全部正確選項且不可多選。未作答選擇題視為答錯。
- **簡答與申論供自行對照參考答案，不自動評分。** 正確率只計算選擇題。
- 練習建立時保存題目、答案與解析快照。之後編輯或刪除題庫也不會改變該次作答紀錄；作答中的回應不包含答案與解析。作答紀錄可在「紀錄」頁刪除，刪除後統計會一併更新。
- 作答紀錄頁顯示最近 100 次，資料庫保留全部紀錄；交卷後可逐頁對照並點「查看解析」。

## AI 呼叫 API

外部 AI 工具需具備 HTTP 呼叫能力。先在「帳號」頁建立 API key（加入的題目進入共用題庫），使用 `X-API-Key: <key>` 或 `Authorization: Bearer <key>` header 驗證；網頁則使用登入 cookie。專案提供接收題目的 API，不主動呼叫 AI，也不需要設定模型服務金鑰。

以下路由都使用 `/api/v1` 前綴，且都需要 API key。API key 只能用在 `/api/v1/` 路徑；少了 `/v1` 會回傳 401，`/api/v1/` 底下不存在的路徑回傳 404：

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/types` | 支援的題型 |
| GET | `/catalog` | 題數、科目、章節、語言 |
| GET | `/questions` | 分頁題庫 |
| POST | `/questions` | 新增單題 |
| POST | `/questions/bulk` | 批次新增，整批成功或整批回復 |
| GET | `/questions/:type/:id` | 讀取單題 |
| PUT | `/questions/:type/:id` | 完整更新單題（不可變更題型） |
| DELETE | `/questions/:type/:id` | 刪除單題 |
| GET | `/questions/export` | 匯出 CSV |
| POST | `/questions/import` | 匯入 CSV，body 是 `{"csv":"CSV內容"}` |

清單與匯出支援 `type`、`subject`、`chapter`、`language`、`search` 查詢參數（`chapter` 可重複以選多個章節）；清單另外支援 `page`、`limit`（最多 100）。Catalog 的各題型題數支援範圍篩選。

### 批次新增範例

把下面內容儲存為 `questions.json`：

```json
{
  "questions": [
    {
      "type": "single",
      "subject": "計算機概論",
      "chapter": "資料庫",
      "question": "SQLite 屬於哪一種資料庫？",
      "options": ["關聯式資料庫", "圖形資料庫"],
      "answer": 0,
      "explanation": "SQLite 使用關聯式資料表與 SQL。",
      "language": "zh-TW"
    }
  ]
}
```

讓呼叫工具從環境變數讀取 key：

```sh
curl http://127.0.0.1:3000/api/v1/questions/bulk \
  -H "X-API-Key: $PRACTICE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @questions.json
```

成功回傳 HTTP 201 與 `{"questions":[...]}`。每批 1–2,000 題，JSON 請求最多 5 MB。缺少或無效的 key 回傳 401，格式錯誤回傳 400，找不到題目回傳 404。API 每個來源 IP 每分鐘最多 120 次請求。

| type | options | answer |
| --- | --- | --- |
| `single` | 2–12 個非空白字串 | 正確索引，例如 `0` |
| `multiple` | 2–12 個非空白字串 | 不重複索引陣列，例如 `[0,2]` |
| `short` | `[]` 或省略 | 非空白參考答案字串 |
| `essay` | `[]` 或省略 | 非空白參考答案字串 |

所有題型的 `subject`、`chapter`、`question`、`answer`、`explanation`、`language` 都必填。語言是自由文字，建議使用 `zh-TW` 或 `en`。題目、參考答案與解析上限 50,000 字；科目、章節及語言上限 200 字。

## CSV 格式

UTF-8（支援 BOM），欄位：

```text
type,subject,chapter,question,options,answer,explanation,language
```

`options`、`answer` 欄位必須是 JSON：單選答案 `0`，多選答案 `[0,2]`，文字答案 `"參考答案"`。CSV 本身的逗號、引號、換行必須依 CSV 規則跳脫，直接使用下載範例或匯出檔最方便。

匯出檔為所有符合目前篩選的題目，包含所有頁面。為避免試算表將文字當成公式，開頭為 `= + - @ tab CR` 的欄位會加上單引號；匯入時會還原這個前綴，因此原文刻意以「單引號緊接上述字元」開頭時，請透過 JSON API 匯入以完整保留。匯入只新增題目，不依 ID 更新；再次匯入相同檔案會新增重複題目。單次匯入最多 2,000 題，網頁檔案限制 4 MB。

## Docker

```sh
docker compose up -d --build
docker compose exec practice npm run account -- create yourname
```

開啟 <http://127.0.0.1:3000>。SQLite 儲存於 `practice-data` volume；請勿執行 `docker compose down -v`，除非要移除資料。Compose 預設只公開給本機，適合個人使用。

若要放到外網，請使用 HTTPS 反向代理，並設定 `NODE_ENV=production`（啟用 Secure cookie），僅在單層可信反向代理後設定 `TRUST_PROXY=1`。預設環境是本機 HTTP，沒有公開部署。

## 資料與擴充

介面依 `ui-ux-pro-max` 技能檢查與調整，設計規範見 [design-system/MASTER.md](design-system/MASTER.md)。

```text
src/
  app.js              HTTP API、登入與練習流程
  auth.js             密碼雜湊、帳號與 API key
  db.js               SQLite 結構、索引與 transaction
  question-types.js   題型註冊、驗證與批改模組
  questions.js        題庫與 CSV
  server.js           啟動與結束
scripts/account.js    管理帳號與 API keys
public/               繁體中文原生 JS 介面與 CSV 範例
```

增加題型時，在 `question-types.js` 註冊 table、label、validate、validateResponse 與 grade，啟動時會建立對應資料表；同步擴充前端題型選擇與作答元件。現有資料表以 `CREATE TABLE IF NOT EXISTS` 初始化；未來變更既有欄位時需另加資料庫 migration。

預設資料庫為 `data/practice.sqlite`，可用 `DATABASE_PATH` 改變位置。備份時請先停止服務及帳號 scripts，再備份整個 `data/` 目錄（包含可能存在的 WAL 檔）。題庫 CSV 只備份題目，不包含帳號、API key 或作答紀錄。

## 驗證

```sh
npm audit
```
