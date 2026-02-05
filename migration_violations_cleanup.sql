-- 遷移腳本：統一違規追蹤系統
-- 目的：廢棄 violations 表，統一使用 violation_logs

-- 步驟 1: 檢查 violations 表是否包含重要數據，如有則備份
-- 如需還原舊數據，可執行：
-- INSERT INTO violation_logs (user_id, chat_id, reason, created_at)
-- SELECT user_id, chat_id, 'migrated from violations', now() FROM violations;

-- 步驟 2: 移除舊的 violations 表
DROP TABLE IF EXISTS violations CASCADE;

-- 步驟 3: 確認 violation_logs 已有完整索引以支援高效查詢
-- (已在 supabase_schema.sql 中定義，此處僅確認)
-- 若未來需要按 user_id + chat_id 進行聚合查詢，可添加完整索引：
CREATE INDEX IF NOT EXISTS violation_logs_user_chat_idx 
ON violation_logs (user_id, chat_id, created_at DESC);

-- 步驟 4: 添加額外的索引以支援日誌查詢與統計
CREATE INDEX IF NOT EXISTS violation_logs_created_at_idx 
ON violation_logs (created_at DESC);

-- 確認遷移成功
SELECT COUNT(*) as total_logs FROM violation_logs;
