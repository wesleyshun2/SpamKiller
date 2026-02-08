-- supabase_recreate_all.sql
-- WARNING: This script Deletes existing schema objects and RECREATES them from scratch.
-- MAKE SURE you have backed up your data. Only run if you are ready to wipe and rebuild.

-- Drop known functions and tables (safe with IF EXISTS)
DROP FUNCTION IF EXISTS match_spam_patterns CASCADE;
DROP FUNCTION IF EXISTS match_normal_patterns CASCADE;

DROP TABLE IF EXISTS violation_logs CASCADE;
DROP TABLE IF EXISTS spam_patterns CASCADE;
DROP TABLE IF EXISTS normal_patterns CASCADE;
DROP TABLE IF EXISTS whitelist CASCADE;
DROP TABLE IF EXISTS config CASCADE;

-- Ensure pgvector is available
CREATE EXTENSION IF NOT EXISTS vector;

-- 1) Recreate config table (fresh)
CREATE TABLE IF NOT EXISTS config (
  key text PRIMARY KEY,
  value jsonb,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE config ENABLE ROW LEVEL SECURITY;

-- RLS 政策：允許 Service Role 存取
DROP POLICY IF EXISTS "Allow service role access config" ON config;
CREATE POLICY "Allow service role access config" ON config
  FOR ALL USING (true)
  WITH CHECK (true);

-- Insert default config values (only if not present)
INSERT INTO config (key, value) VALUES
('punishment_threshold', '3'),
('appeal_channel', '"請私訊管理員"'),
('stats_channel_id', 'null'),
('dry_run', 'false'),
('observation_channel_id', 'null'),
('control_channel_id', 'null'),
('monitored_groups', '[]')
ON CONFLICT (key) DO NOTHING;

-- 2) Whitelist
CREATE TABLE IF NOT EXISTS whitelist (
  user_id bigint PRIMARY KEY,
  username text,
  added_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE whitelist ENABLE ROW LEVEL SECURITY;

-- RLS 政策：允許 Service Role 存取
DROP POLICY IF EXISTS "Allow service role access whitelist" ON whitelist;
CREATE POLICY "Allow service role access whitelist" ON whitelist
  FOR ALL USING (true)
  WITH CHECK (true);

-- 3) Spam patterns (embeddings)
CREATE TABLE IF NOT EXISTS spam_patterns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text,
  embedding vector(768),
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  use_count int DEFAULT 1
);
ALTER TABLE spam_patterns ENABLE ROW LEVEL SECURITY;

-- RLS 政策：允許 Service Role 存取
DROP POLICY IF EXISTS "Allow service role access spam_patterns" ON spam_patterns;
CREATE POLICY "Allow service role access spam_patterns" ON spam_patterns
  FOR ALL USING (true)
  WITH CHECK (true);
-- 使用 HNSW 索引（較 IVFFlat 更穩定）
CREATE INDEX IF NOT EXISTS spam_patterns_embedding_idx ON spam_patterns USING hnsw (embedding vector_cosine_ops);

-- 4) Normal patterns (embeddings)
CREATE TABLE IF NOT EXISTS normal_patterns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text,
  embedding vector(768),
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  use_count int DEFAULT 1
);
ALTER TABLE normal_patterns ENABLE ROW LEVEL SECURITY;

-- RLS 政策：允許 Service Role 存取
DROP POLICY IF EXISTS "Allow service role access normal_patterns" ON normal_patterns;
CREATE POLICY "Allow service role access normal_patterns" ON normal_patterns
  FOR ALL USING (true)
  WITH CHECK (true);
-- 使用 HNSW 索引（較 IVFFlat 更穩定）
CREATE INDEX IF NOT EXISTS normal_patterns_embedding_idx ON normal_patterns USING hnsw (embedding vector_cosine_ops);

-- 5) Violation logs
CREATE TABLE IF NOT EXISTS violation_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  reason text,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE violation_logs ENABLE ROW LEVEL SECURITY;

-- RLS 政策：允許 Service Role 存取
DROP POLICY IF EXISTS "Allow service role access violation_logs" ON violation_logs;
CREATE POLICY "Allow service role access violation_logs" ON violation_logs
  FOR ALL USING (true)
  WITH CHECK (true);
CREATE INDEX IF NOT EXISTS violation_logs_user_chat_idx ON violation_logs (user_id, chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS violation_logs_created_at_idx ON violation_logs (created_at DESC);

-- 6) Functions: match_spam_patterns
-- 防呆：限制 match_count 上限為 20（避免意外請求過大）
CREATE OR REPLACE FUNCTION match_spam_patterns (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
RETURNS TABLE (id uuid, content text, similarity float)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  safe_count int;
BEGIN
  -- 防呆：驗證 embedding 維度（768）和 match_count 上限
  IF query_embedding IS NULL THEN
    RAISE EXCEPTION 'query_embedding cannot be NULL';
  END IF;
  
  safe_count := LEAST(match_count, 20); -- 上限 20 筆
  IF safe_count < 1 THEN
    safe_count := 1;
  END IF;
  
  RETURN QUERY
  SELECT
    spam_patterns.id,
    spam_patterns.content,
    1 - (spam_patterns.embedding <=> query_embedding) as similarity
  FROM spam_patterns
  WHERE 1 - (spam_patterns.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT safe_count;
END;
$$;

-- 7) Functions: match_normal_patterns
-- 防呆：限制 match_count 上限為 20（避免意外請求過大）
CREATE OR REPLACE FUNCTION match_normal_patterns (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
RETURNS TABLE (id uuid, content text, similarity float, use_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  safe_count int;
BEGIN
  -- 防呆：驗證 embedding 和 match_count 上限
  IF query_embedding IS NULL THEN
    RAISE EXCEPTION 'query_embedding cannot be NULL';
  END IF;
  
  safe_count := LEAST(match_count, 20); -- 上限 20 筆
  IF safe_count < 1 THEN
    safe_count := 1;
  END IF;
  
  RETURN QUERY
  SELECT
    normal_patterns.id,
    normal_patterns.content,
    1 - (normal_patterns.embedding <=> query_embedding) as similarity,
    normal_patterns.use_count
  FROM normal_patterns
  WHERE 1 - (normal_patterns.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT safe_count;
END;
$$;

-- Final sanity checks
SELECT 'Recreate complete' AS status;
SELECT COUNT(*) AS config_count FROM config;
SELECT COUNT(*) AS spam_patterns_count FROM spam_patterns;
SELECT COUNT(*) AS normal_patterns_count FROM normal_patterns;
SELECT COUNT(*) AS violation_logs_count FROM violation_logs;
SELECT COUNT(*) AS whitelist_count FROM whitelist;
