-- Vanthara Social Publishing — D1 schema
-- Run this once in the Cloudflare D1 console after creating the vanthara-social database.

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  media_key TEXT NOT NULL,          -- R2 object key
  media_type TEXT NOT NULL,         -- 'image' | 'video'
  caption TEXT NOT NULL DEFAULT '',
  youtube_title TEXT,               -- optional separate title for YouTube uploads
  platforms TEXT NOT NULL,          -- JSON array, e.g. ["instagram","facebook","youtube"]
  scheduled_at TEXT,                -- ISO datetime; null = publish as soon as approved
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | approved | published | failed | rejected
  results TEXT,                     -- JSON: per-platform outcome {instagram:{ok,url|error}, ...}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  platform TEXT PRIMARY KEY,        -- 'youtube' | 'meta'
  data TEXT NOT NULL,               -- JSON blob: refresh_token / page_id / ig_user_id / page_access_token etc.
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at);
