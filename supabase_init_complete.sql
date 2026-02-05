-- 完整初始化腳本：保留 config 表，重新建立所有其他表和函數
-- 執行此腳本前，確保已備份重要數據

-- 刪除舊的表（保留 config）
DROP TABLE IF EXISTS violation_logs CASCADE;
DROP TABLE IF EXISTS violations CASCADE;
DROP TABLE IF EXISTS spam_patterns CASCADE;
DROP TABLE IF EXISTS normal_patterns CASCADE;
DROP TABLE IF EXISTS whitelist CASCADE;
DROP FUNCTION IF EXISTS match_spam_patterns CASCADE;
DROP FUNCTION IF EXISTS match_normal_patterns CASCADE;

-- 確保 pgvector 擴充功能已啟用
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. 白名單表格
CREATE TABLE IF NOT EXISTS whitelist (
    user_id bigint PRIMARY KEY,
    username text,
    added_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE whitelist ENABLE ROW LEVEL SECURITY;

-- 2. 廣告特徵向量表格
CREATE TABLE IF NOT EXISTS spam_patterns (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    content text,
    embedding vector(768),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    use_count int DEFAULT 1
);
ALTER TABLE spam_patterns ENABLE ROW LEVEL SECURITY;

-- 建立向量索引以加速搜尋
CREATE INDEX ON spam_patterns USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 3. 正常訊息特徵向量表格
CREATE TABLE IF NOT EXISTS normal_patterns (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    content text,
    embedding vector(768),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    use_count int DEFAULT 1
);
ALTER TABLE normal_patterns ENABLE ROW LEVEL SECURITY;

-- 建立向量索引以加速搜尋
CREATE INDEX ON normal_patterns USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 4. 設定表格（保留現有數據）
-- config 表應該已存在，直接使用
-- IF NOT EXISTS 確保不會覆蓋現有的配置

CREATE TABLE IF NOT EXISTS config (
    key text PRIMARY KEY,
    value jsonb,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE config ENABLE ROW LEVEL SECURITY;

-- 初始化預設設定（僅當該鍵不存在時）
INSERT INTO config (key, value) VALUES
('punishment_threshold', '3'),
('appeal_channel', '"請私訊管理員"'),
('stats_channel_id', 'null'),
('dry_run', 'false'),
('observation_channel_id', 'null'),
('control_channel_id', 'null'),
('monitored_groups', '[]')
ON CONFLICT (key) DO NOTHING;

-- 5. 違規紀錄日誌表格（統一的違規追蹤系統）
CREATE TABLE IF NOT EXISTS violation_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id bigint NOT NULL,
    chat_id bigint NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE violation_logs ENABLE ROW LEVEL SECURITY;

-- 建立高效查詢索引
CREATE INDEX IF NOT EXISTS violation_logs_user_chat_idx 
ON violation_logs (user_id, chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS violation_logs_created_at_idx 
ON violation_logs (created_at DESC);

-- 6. 相似度搜尋函式

-- 6.1 廣告模式相似度搜尋
CREATE OR REPLACE FUNCTION match_spam_patterns (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  content text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    spam_patterns.id,
    spam_patterns.content,
    1 - (spam_patterns.embedding <=> query_embedding) as similarity
  FROM spam_patterns
  WHERE 1 - (spam_patterns.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- 6.2 正常模式相似度搜尋
CREATE OR REPLACE FUNCTION match_normal_patterns (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  content text,
  similarity float,
  use_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    normal_patterns.id,
    normal_patterns.content,
    1 - (normal_patterns.embedding <=> query_embedding) as similarity,
    normal_patterns.use_count
  FROM normal_patterns
  WHERE 1 - (normal_patterns.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- 驗證初始化
SELECT 'Initialization complete!' as status;
SELECT COUNT(*) as config_records FROM config;
SELECT 'All tables created successfully' as result;
