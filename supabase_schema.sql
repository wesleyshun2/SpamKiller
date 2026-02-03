-- 啟用 pgvector 擴充功能以支援向量運算
create extension if not exists vector;

-- 1. 白名單表格
create table if not exists whitelist (
    user_id bigint primary key,
    username text,
    added_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. 廣告特徵向量表格
create table if not exists spam_patterns (
    id uuid default gen_random_uuid() primary key,
    content text,
    embedding vector(768), -- Gemini embedding-001 / text-embedding-004 使用 768 維度
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    use_count int default 1
);

-- 建立向量索引以加速搜尋
create index on spam_patterns using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- 3. 違規紀錄表格
create table if not exists violations (
    user_id bigint,
    chat_id bigint,
    count int default 1,
    last_violation timestamp with time zone default timezone('utc'::text, now()) not null,
    primary key (user_id, chat_id)
);

-- 4. 設定表格
create table if not exists config (
    key text primary key,
    value jsonb,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 初始化預設設定
insert into config (key, value) values
('punishment_threshold', '3'),
('appeal_channel', '"請私訊管理員"'),
('stats_channel_id', 'null')
on conflict (key) do nothing;

-- 5. 相似度搜尋函式
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
