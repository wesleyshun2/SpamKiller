# Telegram 廣告過濾機器人 (TG Spam Filter Bot)

這是一個基於 Cloudflare Workers、Supabase 與 Google Gemini API 開發的語意化廣告過濾機器人。

## 功能特點
- **語意判斷**：使用 Gemini Embedding 進行向量比對，並在模糊地帶使用 AI 進行最終裁定。
- **自動學習**：管理員可透過回覆訊息並輸入 `/spam` 讓機器人學習新的廣告模式。
- **處分機制**：自動刪除廣告、發送申訴管道資訊，並對一天內多次犯規者進行封鎖。
- **白名單**：支援動態管理白名單。
- **統計資料**：每日定時發送處理量與封鎖清單至指定頻道。
- **資源優化**：自動合併相似廣告向量，節省資料庫空間。

## 部署說明

### 1. 資料庫設定 (Supabase)
請在 Supabase 的 SQL Editor 中執行 `supabase_schema.sql` 檔案中的內容，以建立必要的表格與向量搜尋函式。

### 2. 環境變數設定
請在 Cloudflare Workers 控制台或使用 `wrangler secret put` 設定以下環境變數：
- `TG_TOKEN`: Telegram Bot Token
- `GEMINI_API_KEY`: Google Gemini API Key
- `SUPABASE_URL`: Supabase 專案 URL
- `SUPABASE_SERVICE_KEY`: Supabase Service Role Key (需具備寫入權限)
- `FORWARD_CHANNEL_ID`: (選填) 所有訊息轉發紀錄的頻道 ID

### 3. 部署至 Cloudflare Workers
```bash
npm install
npx wrangler deploy
```

### 4. 設定 Telegram Webhook
部署完成後，請造訪以下網址（將括號內容替換為您的資訊）：
`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>`

## 管理指令
- `/whitelist`: (管理員用) 回覆某人訊息以將其加入白名單。
- `/spam`: (管理員用) 回覆廣告訊息以學習模式、紀錄違規並刪除。
- `/config [key] [value]`: (管理員用) 修改設定。
  - `threshold`: 封鎖門檻 (預設 3)
  - `appeal`: 申訴管道說明
  - `stats_channel`: 統計資料接收頻道 ID
