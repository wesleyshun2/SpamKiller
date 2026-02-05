-- 啟用 pgvector 擴充功能以支援向量運算
create extension if not exists vector;

-- 1. 白名單表格
create table if not exists whitelist (
    user_id bigint primary key,
    username text,
    added_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table whitelist enable row level security;

-- 2. 廣告特徵向量表格
create table if not exists spam_patterns (
    id uuid default gen_random_uuid() primary key,
    content text,
    embedding vector(768), -- Gemini embedding-001 / text-embedding-004 使用 768 維度
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    use_count int default 1
);
alter table spam_patterns enable row level security;

-- 建立向量索引以加速搜尋
create index on spam_patterns using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- 3. 正常訊息特徵向量表格 (用於改善判斷準確度)
create table if not exists normal_patterns (
    id uuid default gen_random_uuid() primary key,
    content text,
    embedding vector(768),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    use_count int default 1
);
alter table normal_patterns enable row level security;

-- 建立向量索引以加速搜尋
create index on normal_patterns using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- 4. 設定表格
create table if not exists config (
    key text primary key,
    value jsonb,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table config enable row level security;

-- 初始化預設設定
insert into config (key, value) values
('punishment_threshold', '3'),
('appeal_channel', '"請私訊管理員"'),
('stats_channel_id', 'null'),
('dry_run', 'false'),
('observation_channel_id', 'null'),
('control_channel_id', 'null')
on conflict (key) do nothing;

-- 5. 相似度搜尋函式

-- 5.1 廣告模式相似度搜尋
create or replace function match_spam_patterns (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  content text,
  similarity float
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    spam_patterns.id,
    spam_patterns.content,
    1 - (spam_patterns.embedding <=> query_embedding) as similarity
  from spam_patterns
  where 1 - (spam_patterns.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
end;
$$;

-- 5.2 正常模式相似度搜尋
create or replace function match_normal_patterns (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  content text,
  similarity float,
  use_count int
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    normal_patterns.id,
    normal_patterns.content,
    1 - (normal_patterns.embedding <=> query_embedding) as similarity,
    normal_patterns.use_count
  from normal_patterns
  where 1 - (normal_patterns.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
end;
$$;

-- 6. 違規紀錄日誌表格 (Log-based tracking)
create table if not exists violation_logs (
    id uuid default gen_random_uuid() primary key,
    user_id bigint not null,
    chat_id bigint not null,
    reason text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table violation_logs enable row level security;

-- 建立高效查詢索引
create index if not exists violation_logs_user_chat_idx 
on violation_logs (user_id, chat_id, created_at DESC);
create index if not exists violation_logs_created_at_idx 
on violation_logs (created_at DESC);
