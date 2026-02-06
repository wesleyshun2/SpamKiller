# Telegram 智能廣告過濾機器人 (TG Spam Filter Bot)

這是一個基於 **Cloudflare Workers**、**Supabase (pgvector)** 與 **Google Gemini API** 構建的生產級 Telegram 防垃圾訊息機器人。它具備企業級的可靠性設計，包含多模型自動切換、雙重 API 版本備援以及即時監控面板。

## 🌟 核心特色 (v2.0)

### 360° 全方位防禦
1.  **雙重判斷機制 (Dual-Layer Defense)**：
    *   **第一層 (Vector Search)**：利用 Embedding 向量技術，毫秒級比對已知廣告庫 (相似度 > 0.85 即攔截)。
    *   **第二層 (LLM Analysis)**：若向量庫無匹配，自動呼叫 Google Gemini 進行深層語意分析 (結合使用者 Bio 與 Context)。
2.  **動態白名單**：優先檢查快取與白名單，降低 API 開銷並避免誤判。
3.  **自動學習 (Auto-Learning)**：當 AI 判定為廣告時，自動將該特徵寫入向量資料庫，下次遇到類似廣告直接由第一層攔截。

### 🛡️ 高可用性與強韌設計 (Robustness)
*   **多模型自動輪詢 (Multi-Model Fallback)**：
    *   內建「不死鳥」機制，依序嘗試 `gemini-2.0-flash`, `2.0-Lite`, `1.5-Flash`, `1.5-Pro` 等模型。
    *   自動偵測 **429 (Quota Exceeded)** 並切換至下一個可用模型。
*   **雙 API 版本備援**：
    *   針對 **404 (Not Found)** 錯誤，自動在 `v1beta` 與 `v1` 穩定版 API 間切換，確保不受 Google API 改版影響。
*   **智慧轉發與錯誤修復**：
    *   轉發失敗時自動偵測原因 (如群組升級、權限不足) 並回傳具體修復建議。

---

## 🛠️ 部署說明

### 1. 資料庫設定 (Supabase)
如果你尚未初始化資料庫，請在 Supabase 的 SQL Editor 中執行 `supabase_schema.sql`，建立必要的表格與向量函式（包含 `whitelist`, `spam_patterns`, `normal_patterns`, `violation_logs` 及相關 RPC）。

已移除臨時遷移與初始化腳本，若你已經由我或其他方式完成資料庫初始化，則可跳過此步驟。

### 2. 環境變數設定 (Cloudflare Workers)
使用 `wrangler secret put` 或在 Dashboard 設定：
- `TG_TOKEN`: Telegram Bot Token
- `GEMINI_API_KEY`: Google Gemini API Key
- `SUPABASE_URL`: Supabase 專案 URL
- `SUPABASE_SERVICE_KEY`: Supabase Service Role Key (需具備寫入權限)
- `FORWARD_CHANNEL_ID`: (選填) 預設的日誌轉發頻道 ID

### 3. 部署
```bash
# 安裝依賴
npm install

# 部署到 Cloudflare Workers
npx wrangler deploy
```

### 4. 啟用 Webhook
```bash
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
```

---

## 💻 指令手冊

### 基礎管理
*   `/ping` - 檢查機器人存活狀態與當前 Chat ID。
*   `/monitor` - **[開關]** 啟用或暫停對當前群組的廣告監控 (切換制)。
*   `/whitelist` - (回覆訊息) 將使用者加入白名單，永不標記為 Spam。
*   `/spam` - (回覆訊息) 手動標記為廣告。機器人會學習此特徵並刪除訊息。

### 系統配置 (/config)
用法：`/config [key] [value]`
*   `forward_channel [ID]` - 設定日誌轉發頻道 (例如 `-100xxxx`)。
*   `threshold [次數]` - 每日違規達幾次後封鎖使用者。
*   `dry_run [true/false]` - 演習模式。開啟後只會通知觀察頻道，不會實際刪除訊息。
*   `appeal [文字]` - 設定刪除訊息時顯示的申訴管道資訊。