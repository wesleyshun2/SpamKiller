# SpamKiller v2.1 變更日誌 (2026-02-05)

## 概述
本次更新隆焦于優化違規追蹤系統、增強日誌功能，以及改善管理員指令體驗。

---

## 🔧 技術變更

### 1. 違規記錄系統重構 (核心改進)

#### 問題
- 存在兩個違規相關的表：`violations` (計數型) 和 `violation_logs` (日誌型)
- 代碼僅使用 `violation_logs`，導致數據不一致
- `violations` 表的 `count` 欄位在 `recordViolation` 返回時沒有正確遞增

#### 解決方案
✅ **統一使用 `violation_logs` 表**
- 移除舊的 `violations` 表
- 更新 `recordViolation()` 返回正確的 24 小時內違規計數
- 添加高效索引：`violation_logs_user_chat_idx` 和 `violation_logs_created_at_idx`

**受影響的文件**:
- [supabase_schema.sql](supabase_schema.sql) - 移除 violations 表，優化索引
- [src/supabase.ts](src/supabase.ts) - 修複計數邏輯，添加 `getViolationCountForUser()` 方法
- [migration_violations_cleanup.sql](migration_violations_cleanup.sql) - **⚠️ 必須執行此遷移**

### 2. 增強日誌系統

#### 新功能
✅ **嵌入模型狀態報告**
- 日誌信息中現在包含：
  - 嵌入模型名稱 (e.g., `gemini-embedding-001`)
  - 向量化狀態 (✓ 已向量化 / ✗ 無向量)

✅ **改進的日誌格式**
- 從簡單的 `[EX/OK]` 改為詳細的結構化報告
- 支持 Markdown 格式化，更易於閱讀
- 包含更多判斷上下文

**Markdown 格式範例**:
```
❌ **判定結果**: 廣告 (SPAM)
📊 **相似度**: 0.8723
🧠 **判斷來源**: Vector (ID: abc-123)
📝 **詳細說明**: Vector Match (ID: abc-123)
🔧 **嵌入模型**: ✓ 已向量化 (gemini-embedding-001)
```

**受影響的文件**:
- [src/bot.ts](src/bot.ts) - 更新日誌報告格式，添加 `parse_mode: 'Markdown'`
- [src/gemini.ts](src/gemini.ts) - 添加 `getEmbeddingModel()` 方法

### 3. 管理員標記學習機制

#### 新功能
✅ **添加 `/normal` 命令**
- 管理員可標記某訊息為正常（非廣告）
- 自動提取向量並存入 `normal_patterns` 表
- 學習用戶反饋，改進模型準確度

#### 架構
- **`spam_patterns` 表**: 存儲廣告特徵向量
- **`normal_patterns` 表 (NEW)**: 存儲正常訊息特徵向量
- 分離存儲，避免向量比對時產生誤判

#### 新的 RPC 函數
`match_normal_patterns(query_embedding, match_threshold, match_count)`
- 搜尋相似的正常訊息模式
- 支持動態閾值調整

**受影響的文件**:
- [src/bot.ts](src/bot.ts) - 添加 `/normal` 命令處理器
- [src/supabase.ts](src/supabase.ts) - 添加 `addNormalPattern()` 方法
- [supabase_schema.sql](supabase_schema.sql) - 新增 `normal_patterns` 表 & `match_normal_patterns()` RPC

### 4. 改善命令體驗 (UX 優化)

#### `/config` 命令增強
✅ **改進的幫助信息**
```
/config              # 無參數時顯示當前配置和幫助
/config [key] [val]  # 設定值
```

✅ **新增控制頻道配置**
- `/config control_channel [ID]` - 限制指令執行的頻道
- 優先級：控制頻道 > 轉發頻道 > 全局

✅ **改進的返回消息**
- 使用 Emoji 和 Markdown 格式
- 清晰的配置說明
- 錯誤提示更具體

**受影響的文件**:
- [src/bot.ts](src/bot.ts) - 完全重寫 `/config` 命令
- [src/types.ts](src/types.ts) - 添加 `control_channel_id` 字段
- [src/supabase.ts](src/supabase.ts) - 更新 `getConfig()` 返回值
- [supabase_schema.sql](supabase_schema.sql) - 初始化 `control_channel_id` 配置

---

## 📊 數據庫變更摘要

### 新增表
| 表名 | 用途 | 主鍵 |
|------|------|------|
| `normal_patterns` | 正常訊息特徵向量 | `id` (UUID) |

### 新增 RPC 函數
| 函數 | 簽名 | 用途 |
|------|------|------|
| `match_normal_patterns()` | `(vector, float, int) → table` | 搜尋相似正常訊息 |

### 移除表
| 表名 | 原因 |
|------|------|
| `violations` | 已被 `violation_logs` 取代，結構冗餘 |

### 新增索引
```sql
violation_logs_user_chat_idx    -- (user_id, chat_id, created_at DESC)
violation_logs_created_at_idx   -- (created_at DESC)
normal_patterns_ivfflat_idx     -- 向量索引
```

---

## 🚀 部署指南

### 前置準備
1. 備份現有 Supabase 數據（可選但建議）

### 步驟
1. **執行數據庫遷移**
   ```sql
   -- 在 Supabase SQL Editor 執行:
   -- 文件: migration_violations_cleanup.sql
   DROP TABLE IF EXISTS violations CASCADE;
   CREATE INDEX IF NOT EXISTS violation_logs_user_chat_idx 
   ON violation_logs (user_id, chat_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS violation_logs_created_at_idx 
   ON violation_logs (created_at DESC);
   ```

2. **創建新表和 RPC 函數**
   ```sql
   -- 執行 supabase_schema.sql 中的相關部分
   -- 或直接執行以下命令創建 normal_patterns 表和 RPC
   ```

3. **部署代碼**
   ```bash
   cd /path/to/SpamKiller
   npm install
   npx wrangler deploy
   ```

4. **驗證部署**
   - 在 Telegram 群組中執行 `/ping` 確認機器人回應
   - 執行 `/config` (無參數) 查看幫助信息
   - 嘗試 `/normal` 命令測試新功能

---

## 📝 新增命令

| 命令 | 用法 | 說明 |
|------|------|------|
| `/normal` | `/normal` (回覆訊息) | **[NEW]** 標記訊息為正常，自動學習特徵 |
| `/config` | 無參數 | **[ENHANCED]** 顯示當前配置和幫助 |
| `/config control_channel [ID]` | 設置值 | **[NEW]** 指定控制頻道 |

---

## ⚠️ 重要提示

### 必須執行的操作
1. ✅ 執行 `migration_violations_cleanup.sql` 遷移腳本
2. ✅ 確保 Supabase 中存在 `normal_patterns` 表
3. ✅ 重新部署 Cloudflare Workers

### 向下相容性
- ✅ 所有現有命令保持相同行為
- ✅ 現有的 `/config` 配置選項不變
- ✅ 日誌轉發邏輯不變

### 性能影響
- 📈 新增索引將改善 `violation_logs` 查詢性能
- 📉 `normal_patterns` 表的初期為空，不影響性能

---

## 📈 未來規劃

### 短期 (v2.2)
- [ ] 圖形化配置介面 (Telegram 內聯按鈕)
- [ ] 統計儀表板 (`/stats` 命令)
- [ ] 日誌導出功能

### 中期 (v3.0)
- [ ] 多語言支援
- [ ] 自定義廣告檢測模型
- [ ] 代理管理員制度

---

## 詞彙表

| 術語 | 定義 |
|------|------|
| **向量化** | 使用 embedding 模型將文字轉換為數值向量 |
| **相似度** | 兩個向量之間的餘弦相似度 (0-1 之間) |
| **阈值** | 相似度超過此值時觸發判定 |
| **違規** | 一次被判定為廣告並被刪除的訊息 |

---

**變更者**: AI Assistant  
**日期**: 2026-02-05  
**版本**: v2.1
