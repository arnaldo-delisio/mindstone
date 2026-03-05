-- MindStone: Initial Schema
-- Single squashed migration synthesized from vault development history.
-- Apply to a fresh Supabase project to get a fully functional schema.
-- Run: supabase db push (or paste into Supabase dashboard SQL editor)
--
-- Source: 24 incremental vault migrations (20260120 – 20260227)
-- Net-empty omissions: time_entries (created then dropped), pg_cron schedule (added then removed)

-- ===================================================================
-- SECTION 1: Extensions
-- ===================================================================

-- pgvector: semantic search via cosine similarity on 1536-dim embeddings
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- pgmq: Postgres-native message queues for async processing pipelines
--   (extraction_queue → intelligence_queue → embeddings_queue)
CREATE EXTENSION IF NOT EXISTS pgmq CASCADE;

-- pg_trgm: fuzzy trigram string matching (author name search, partial matches)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ===================================================================
-- SECTION 2: Seed — Dummy User
-- ===================================================================

-- MindStone is a single-user system. All data is owned by this fixed UUID.
-- OAuth (Google) is used for authentication — this row satisfies the foreign key
-- on files.user_id without being used as an actual login credential.
INSERT INTO auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin,
  confirmation_token,
  email_change_token_new,
  recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'vault@local.dev',
  '$2a$10$dummypasswordhash', -- Dummy bcrypt hash — user never logs in via password
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  false,
  '',
  '',
  ''
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE auth.users IS 'Supabase Auth users table. Contains single dummy user (00000000-0000-0000-0000-000000000001) for single-user vault system.';

-- ===================================================================
-- SECTION 3: Core Tables
-- ===================================================================

-- files: Primary storage for all vault markdown content.
-- Stores file content with parsed frontmatter, content hash for sync
-- conflict detection, and status columns for the async processing pipeline.
CREATE TABLE files (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users,
  path                TEXT        NOT NULL,
  content_hash        TEXT        NOT NULL,
  frontmatter         JSONB,
  body                TEXT,
  size_bytes          BIGINT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),

  -- Semantic search embedding (1536-dim, OpenAI text-embedding-3-small)
  embedding           extensions.vector(1536),

  -- Processing pipeline status columns
  -- Sequential flow: extraction → intelligence → embeddings
  extraction_status   TEXT        DEFAULT 'complete'
                      CHECK (extraction_status IN ('queued', 'processing', 'complete', 'failed')),
  intelligence_status TEXT        DEFAULT 'pending'
                      CHECK (intelligence_status IN ('pending', 'processing', 'complete', 'failed')),
  chunks_status       TEXT        DEFAULT 'queued'
                      CHECK (chunks_status IN ('queued', 'pending', 'processing', 'complete', 'failed')),

  -- MOC (Map of Content) memberships — denormalized for fast search filtering
  moc_memberships     TEXT[]      DEFAULT '{}',

  -- Google Calendar integration columns (used only for events/ files)
  start_time          TIMESTAMPTZ,
  end_time            TIMESTAMPTZ,
  gcal_event_id       TEXT,
  gcal_calendar       TEXT,
  source              TEXT,
  source_file         TEXT,

  -- Unique constraint enables upsert operations (onConflict by path per user)
  UNIQUE(user_id, path)
);

COMMENT ON TABLE files IS 'Stores vault markdown file content with parsed frontmatter and content hashing for sync conflict detection';
COMMENT ON COLUMN files.content_hash IS 'SHA-256 hex digest of file content for change detection and conflict resolution';
COMMENT ON COLUMN files.frontmatter IS 'Parsed YAML frontmatter as JSONB for queryable metadata (tags, status, etc)';
COMMENT ON COLUMN files.body IS 'Markdown body content (everything after frontmatter)';
COMMENT ON COLUMN files.size_bytes IS 'File size in bytes for monitoring and size limit enforcement';
COMMENT ON COLUMN files.embedding IS 'OpenAI text-embedding-3-small embeddings (1536 dimensions) for semantic similarity search';
COMMENT ON COLUMN files.extraction_status IS 'Extraction processing status: queued (waiting for extraction), processing (in progress), complete (done), failed (error occurred)';
COMMENT ON COLUMN files.intelligence_status IS 'Intelligence processing status for auto-tagging, summarization, MOC generation';
COMMENT ON COLUMN files.chunks_status IS 'Embedding processing status: queued (waiting for intelligence), pending (ready for embeddings), processing (in progress), complete (done), failed (error occurred)';
COMMENT ON COLUMN files.moc_memberships IS 'Denormalized array of MOC topics this file belongs to. Updated during MOC generation. Used for search result MOC membership display.';


-- file_chunks: Hierarchical text chunks for semantic search over long documents.
-- Two-level hierarchy:
--   Parent chunks (~1536 tokens, no embedding): semantic section containers
--   Child chunks  (~512 tokens, with embedding): precision retrieval units
-- At search time: query matches best child → parent chunk text returned as snippet context.
CREATE TABLE file_chunks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign key to files table (CASCADE delete ensures chunks removed with file)
  file_id         UUID        NOT NULL REFERENCES files(id) ON DELETE CASCADE,

  -- 0-based index within the file (sequential, unique per file)
  chunk_index     INTEGER     NOT NULL,

  -- Text content stored for snippet generation in search results
  chunk_text      TEXT        NOT NULL,

  -- Embedding only on child chunks (parent_chunk_id IS NOT NULL)
  -- Parent chunks have no embedding (NULL)
  embedding       extensions.vector(1536),

  created_at      TIMESTAMPTZ DEFAULT now(),

  -- NULL for parent chunks; non-NULL for child chunks (points to parent row)
  parent_chunk_id UUID        REFERENCES file_chunks(id) ON DELETE CASCADE,

  UNIQUE(file_id, chunk_index)
);

COMMENT ON TABLE file_chunks IS 'Hierarchical text chunks with embeddings for semantic search across long documents. Parent chunks (~1536 tokens) are section containers; child chunks (~512 tokens, 100-token overlap) are precision retrieval units with embeddings.';
COMMENT ON COLUMN file_chunks.file_id IS 'Reference to parent file in files table. ON DELETE CASCADE ensures chunks removed when file deleted.';
COMMENT ON COLUMN file_chunks.chunk_index IS '0-based index of chunk within file. Combined with file_id ensures unique chunks.';
COMMENT ON COLUMN file_chunks.chunk_text IS 'Text content of chunk, stored for snippet generation in search results.';
COMMENT ON COLUMN file_chunks.embedding IS 'OpenAI text-embedding-3-small embedding (1536 dims) for semantic search. NULL for parent chunks, set on child chunks only.';
COMMENT ON COLUMN file_chunks.parent_chunk_id IS 'NULL for parent chunks (1536-token section containers). Non-NULL for child chunks (512-token retrieval units) — points to their parent. Only children have embeddings.';


-- gcal_sync_state: Tracks Google Calendar incremental sync state.
-- One row per calendar. syncToken enables incremental polling (only changed events).
CREATE TABLE IF NOT EXISTS gcal_sync_state (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id     TEXT        NOT NULL UNIQUE,
  sync_token      TEXT,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===================================================================
-- SECTION 4: Row Level Security
-- ===================================================================

-- Enable RLS on files table — all policies enforce single-user ownership
ALTER TABLE files ENABLE ROW LEVEL SECURITY;

-- Critical: (select auth.uid()) wrapper enables Postgres query planner caching.
-- Without wrapper, auth.uid() is called per row, causing performance degradation at 10K+ files.

CREATE POLICY "Users can create their own files"
ON files FOR INSERT
TO authenticated
WITH CHECK ( (SELECT auth.uid()) = user_id );

CREATE POLICY "Users can read their own files"
ON files FOR SELECT
TO authenticated
USING ( (SELECT auth.uid()) = user_id );

CREATE POLICY "Users can update their own files"
ON files FOR UPDATE
TO authenticated
USING ( (SELECT auth.uid()) = user_id )
WITH CHECK ( (SELECT auth.uid()) = user_id );

CREATE POLICY "Users can delete their own files"
ON files FOR DELETE
TO authenticated
USING ( (SELECT auth.uid()) = user_id );

COMMENT ON POLICY "Users can create their own files" ON files IS 'Allows authenticated users to insert files with their own user_id';
COMMENT ON POLICY "Users can read their own files" ON files IS 'Allows authenticated users to select only their own files';
COMMENT ON POLICY "Users can update their own files" ON files IS 'Allows authenticated users to update only their own files';
COMMENT ON POLICY "Users can delete their own files" ON files IS 'Allows authenticated users to delete only their own files';

-- ===================================================================
-- SECTION 5: Indexes
-- ===================================================================

-- Core indexes on files
CREATE INDEX files_user_id_idx ON files(user_id);
CREATE INDEX files_path_idx ON files(path);

-- HNSW index for fast cosine similarity search on file-level embeddings
-- (legacy: semantic search now operates on file_chunks, but index kept for compatibility)
CREATE INDEX files_embedding_idx
ON files
USING hnsw (embedding extensions.vector_cosine_ops);

-- Frontmatter type index for content type filtering
CREATE INDEX files_frontmatter_type_idx ON files ((frontmatter->>'type'));

-- Partial indexes for processing pipeline status (small & fast — only active rows indexed)
CREATE INDEX files_chunks_status_idx ON files(chunks_status)
  WHERE chunks_status IN ('queued', 'pending', 'failed');

CREATE INDEX files_intelligence_status_idx ON files(intelligence_status)
  WHERE intelligence_status IN ('pending', 'failed');

CREATE INDEX files_extraction_status_idx ON files(extraction_status)
  WHERE extraction_status IN ('queued', 'processing', 'failed');

-- Advanced search filter indexes
CREATE INDEX IF NOT EXISTS idx_files_path_prefix
  ON files USING btree (path text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_files_author
  ON files USING btree (((frontmatter->>'author')));

CREATE INDEX IF NOT EXISTS idx_files_guests
  ON files USING gin ((frontmatter->'guests'));

CREATE INDEX IF NOT EXISTS idx_files_source_type
  ON files USING btree (((frontmatter->>'source_type')));

CREATE INDEX IF NOT EXISTS idx_files_tags
  ON files USING gin ((frontmatter->'tags'));

CREATE INDEX IF NOT EXISTS idx_files_published_date
  ON files USING btree (((frontmatter->>'published_date')));

CREATE INDEX IF NOT EXISTS idx_files_created_at
  ON files USING btree (created_at);

CREATE INDEX IF NOT EXISTS idx_files_path_tags
  ON files USING btree (path, ((frontmatter->'tags')));

-- MOC membership index (GIN for array containment queries)
CREATE INDEX IF NOT EXISTS idx_files_moc_memberships
  ON files USING gin (moc_memberships);

-- pg_trgm fuzzy index for author name matching (e.g., "Huber" → "Andrew Huberman")
CREATE INDEX IF NOT EXISTS idx_files_author_trgm
  ON files USING gin ((frontmatter->>'author') gin_trgm_ops);

COMMENT ON INDEX idx_files_author_trgm IS 'Trigram index for fuzzy author name matching using pg_trgm similarity functions';

-- GCal event indexes on files table
CREATE INDEX IF NOT EXISTS idx_files_start_time
  ON files (user_id, start_time)
  WHERE start_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_files_gcal_event_id
  ON files (gcal_event_id)
  WHERE gcal_event_id IS NOT NULL;

-- file_chunks indexes
CREATE INDEX file_chunks_embedding_idx
  ON file_chunks
  USING hnsw (embedding extensions.vector_cosine_ops);

CREATE INDEX file_chunks_file_id_idx ON file_chunks(file_id);

-- Parent chunk lookup at search time (one point read per result to fetch context)
CREATE INDEX file_chunks_parent_chunk_id_idx ON file_chunks(parent_chunk_id);

-- ===================================================================
-- SECTION 6: Functions — Search
-- ===================================================================

-- hybrid_search: File-level hybrid search (keyword + semantic) via RRF.
-- Note: This function is kept for backward compatibility. New search uses
-- hybrid_search_chunked which operates on child chunks for better precision.
--
-- Parameters:
--   query_text:      Search query string for ILIKE keyword matching
--   query_embedding: Pre-computed embedding vector (pass NULL for keyword-only)
--   p_user_id:       User UUID — required because service role key makes auth.uid() NULL
--   match_count:     Max results to return (default 20)
--   content_type:    Optional frontmatter->>'type' filter (e.g. 'transcript', 'learning')
CREATE OR REPLACE FUNCTION hybrid_search(
  query_text       TEXT,
  query_embedding  extensions.vector(1536),
  p_user_id        UUID,
  match_count      INT     DEFAULT 20,
  content_type     TEXT    DEFAULT NULL
)
RETURNS TABLE (
  path         TEXT,
  body         TEXT,
  frontmatter  JSONB,
  score        FLOAT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH keyword_results AS (
  SELECT
    id, path, body, frontmatter,
    row_number() OVER (ORDER BY updated_at DESC) AS rank_ix
  FROM files
  WHERE
    user_id = p_user_id
    AND body ILIKE '%' || query_text || '%'
    AND (content_type IS NULL OR frontmatter->>'type' = content_type)
  LIMIT match_count * 2
),
semantic_results AS (
  SELECT
    id, path, body, frontmatter,
    row_number() OVER (ORDER BY embedding <=> query_embedding) AS rank_ix
  FROM files
  WHERE
    user_id = p_user_id
    AND embedding IS NOT NULL
    AND query_embedding IS NOT NULL
    AND (content_type IS NULL OR frontmatter->>'type' = content_type)
  LIMIT match_count * 2
)
SELECT
  COALESCE(k.path, s.path)          AS path,
  COALESCE(k.body, s.body)          AS body,
  COALESCE(k.frontmatter, s.frontmatter) AS frontmatter,
  (COALESCE(1.0 / (60 + k.rank_ix), 0.0) +
   COALESCE(1.0 / (60 + s.rank_ix), 0.0))::FLOAT AS score
FROM keyword_results k
FULL OUTER JOIN semantic_results s ON k.id = s.id
ORDER BY
  (COALESCE(1.0 / (60 + k.rank_ix), 0.0) +
   COALESCE(1.0 / (60 + s.rank_ix), 0.0)) DESC
LIMIT match_count
$$;

COMMENT ON FUNCTION hybrid_search(TEXT, extensions.vector(1536), UUID, INT, TEXT) IS
'Combines keyword (ILIKE) and semantic (pgvector) search using Reciprocal Rank Fusion (k=60). Requires explicit p_user_id parameter for service role key compatibility. Pass NULL for query_embedding to use keyword-only search.';


-- hybrid_search_chunked: Primary search function — hierarchical chunk-based hybrid search.
-- Semantic search operates on child chunks (512 tokens, precise embeddings).
-- Parent chunk text (1536 tokens) returned as snippet for richer answer context.
-- Keyword search operates on full file body (ILIKE).
-- Results fused via Reciprocal Rank Fusion (k=60) at file level.
--
-- Parameters: same as hybrid_search above.
-- Returns: file_id, path, score, snippet (parent chunk text or ts_headline fragment)
CREATE OR REPLACE FUNCTION hybrid_search_chunked(
  query_text       TEXT,
  query_embedding  extensions.vector(1536),
  p_user_id        UUID,
  match_count      INT     DEFAULT 20,
  content_type     TEXT    DEFAULT NULL
)
RETURNS TABLE (
  file_id   UUID,
  path      TEXT,
  score     FLOAT,
  snippet   TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH keyword_results AS (
  -- Keyword search on full body text
  SELECT
    f.id, f.path, f.body,
    row_number() OVER (ORDER BY f.updated_at DESC) AS rank_ix
  FROM files f
  WHERE
    f.user_id = p_user_id
    AND f.body ILIKE '%' || query_text || '%'
    AND (content_type IS NULL OR f.frontmatter->>'type' = content_type)
  LIMIT match_count * 2
),
chunk_semantic_results AS (
  -- Semantic search on child chunks only (parent_chunk_id IS NOT NULL)
  -- JOIN to parent to retrieve broader section context for snippet
  SELECT
    fc.file_id,
    p.chunk_text AS parent_text,
    fc.embedding <=> query_embedding AS distance,
    row_number() OVER (ORDER BY fc.embedding <=> query_embedding) AS rank_ix
  FROM file_chunks fc
  JOIN file_chunks p ON fc.parent_chunk_id = p.id
  JOIN files f ON fc.file_id = f.id
  WHERE
    f.user_id = p_user_id
    AND fc.embedding IS NOT NULL
    AND fc.parent_chunk_id IS NOT NULL
    AND query_embedding IS NOT NULL
    AND (content_type IS NULL OR f.frontmatter->>'type' = content_type)
  LIMIT match_count * 2
),
semantic_results AS (
  -- Aggregate to file level: best matching child determines file rank
  SELECT
    file_id,
    MIN(distance)  AS best_distance,
    MIN(rank_ix)   AS rank_ix,
    (ARRAY_AGG(parent_text ORDER BY distance ASC))[1] AS best_chunk_text
  FROM chunk_semantic_results
  GROUP BY file_id
)
SELECT
  COALESCE(k.id, s.file_id) AS file_id,
  COALESCE(k.path, (SELECT path FROM files WHERE id = s.file_id)) AS path,
  (COALESCE(1.0 / (60 + k.rank_ix), 0.0) +
   COALESCE(1.0 / (60 + s.rank_ix), 0.0))::FLOAT AS score,
  CASE
    WHEN s.best_chunk_text IS NOT NULL THEN
      -- Semantic match: return parent chunk text (richer section context)
      substring(s.best_chunk_text, 1, 600)
    ELSE
      -- Keyword-only match: use ts_headline to find match-centered fragment
      ts_headline(
        'simple',
        k.body,
        plainto_tsquery('simple', query_text),
        'MaxWords=60, MinWords=20, MaxFragments=1, StartSel="", StopSel="", FragmentDelimiter=" ... "'
      )
  END AS snippet
FROM keyword_results k
FULL OUTER JOIN semantic_results s ON k.id = s.file_id
ORDER BY
  (COALESCE(1.0 / (60 + k.rank_ix), 0.0) +
   COALESCE(1.0 / (60 + s.rank_ix), 0.0)) DESC
LIMIT match_count
$$;

COMMENT ON FUNCTION hybrid_search_chunked IS
'Hierarchical hybrid search: keyword (ILIKE on body) + semantic (pgvector on 512-token child chunks) with RRF fusion. Child chunks provide precise retrieval; parent chunk text (1536 tokens) returned as snippet for richer context. Aggregates to file level using best-child-per-file strategy.';

-- ===================================================================
-- SECTION 7: Functions — MOC Membership
-- ===================================================================

-- remove_moc_membership: Atomically removes a MOC topic from all files.
-- Called during MOC regeneration to clear stale memberships before re-adding.
CREATE OR REPLACE FUNCTION remove_moc_membership(
  p_user_id  UUID,
  p_moc_topic TEXT
) RETURNS void AS $$
  UPDATE files
  SET moc_memberships = array_remove(moc_memberships, p_moc_topic)
  WHERE user_id = p_user_id;
$$ LANGUAGE sql SECURITY INVOKER;

-- add_moc_membership: Atomically adds a MOC topic to a specific file.
-- Guards against duplicates with the array containment check.
CREATE OR REPLACE FUNCTION add_moc_membership(
  p_user_id   UUID,
  p_file_path TEXT,
  p_moc_topic TEXT
) RETURNS void AS $$
  UPDATE files
  SET moc_memberships = array_append(
    COALESCE(moc_memberships, ARRAY[]::TEXT[]),
    p_moc_topic
  )
  WHERE user_id = p_user_id
    AND path = p_file_path
    AND NOT (moc_memberships @> ARRAY[p_moc_topic]);
$$ LANGUAGE sql SECURITY INVOKER;

COMMENT ON FUNCTION remove_moc_membership IS 'Atomically removes MOC topic from all files during MOC regeneration';
COMMENT ON FUNCTION add_moc_membership IS 'Atomically adds MOC topic to specific file, preventing duplicates';

-- ===================================================================
-- SECTION 8: Functions — Queue Helpers
-- ===================================================================

-- enqueue_for_extraction: Trigger function — enqueues large files for async
-- extraction via Gemini File API when extraction_status = 'queued'.
-- Fires on INSERT or UPDATE of extraction_status.
CREATE OR REPLACE FUNCTION enqueue_for_extraction()
RETURNS trigger AS $$
BEGIN
  IF new.extraction_status = 'queued' THEN
    PERFORM pgmq.send(
      'extraction_queue',
      jsonb_build_object(
        'file_id',     new.id,
        'file_path',   new.path,
        'enqueued_at', now()
      )
    );
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION enqueue_for_extraction IS 'Enqueues large files for async extraction via Gemini File API';

-- enqueue_for_intelligence: Trigger function — enqueues files for intelligence
-- processing (auto-tagging, summarization, MOC generation) after extraction completes.
-- Sequential guard: only fires when intelligence_status='pending' AND extraction_status='complete'.
CREATE OR REPLACE FUNCTION enqueue_for_intelligence()
RETURNS trigger AS $$
BEGIN
  IF new.intelligence_status = 'pending' AND new.extraction_status = 'complete' THEN
    PERFORM pgmq.send(
      'intelligence_queue',
      jsonb_build_object(
        'file_id',        new.id,
        'file_path',      new.path,
        'content_length', length(new.body),
        'enqueued_at',    now()
      )
    );
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION enqueue_for_intelligence IS 'Enqueues file for intelligence only after extraction completes (prevents processing incomplete files)';

-- enqueue_for_embedding: Trigger function — enqueues files for chunk embedding
-- after intelligence completes.
-- Sequential guard: only fires when chunks_status='pending' AND intelligence_status='complete'.
CREATE OR REPLACE FUNCTION enqueue_for_embedding()
RETURNS trigger AS $$
BEGIN
  IF new.chunks_status = 'pending' AND new.intelligence_status = 'complete' THEN
    PERFORM pgmq.send(
      'embeddings_queue',
      jsonb_build_object(
        'file_id',     new.id,
        'file_path',   new.path,
        'batch_size',  20,
        'enqueued_at', now()
      )
    );
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION enqueue_for_embedding IS 'Enqueues file for embeddings only after intelligence processing completes (prevents concurrent OOM)';

-- enqueue_file_for_chunking: Directly enqueue a file for chunk embedding generation,
-- bypassing intelligence processing. Used by add_note and daemon syncer for files
-- that do not need intelligence (daily notes, synced markdown).
-- Sets intelligence_status='complete' + chunks_status='pending' atomically to
-- satisfy the enqueue_for_embedding trigger condition.
-- Pass clear_existing_chunks=true (default) to delete stale chunks before re-enqueueing.
CREATE OR REPLACE FUNCTION enqueue_file_for_chunking(
  p_file_id              UUID,
  p_clear_existing_chunks BOOLEAN DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_clear_existing_chunks THEN
    DELETE FROM file_chunks WHERE file_id = p_file_id;
  END IF;

  UPDATE files
  SET
    intelligence_status = 'complete',
    chunks_status       = 'pending'
  WHERE id = p_file_id;
END;
$$;

COMMENT ON FUNCTION enqueue_file_for_chunking IS
'Directly enqueue a file for chunk embedding generation, bypassing intelligence processing. Sets intelligence_status=complete and chunks_status=pending to satisfy the enqueue_for_embedding trigger condition. Pass clear_existing_chunks=true (default) when re-syncing updated content to avoid stale chunks.';

GRANT EXECUTE ON FUNCTION enqueue_file_for_chunking(UUID, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION enqueue_file_for_chunking(UUID, BOOLEAN) TO authenticated;

-- migrate_stuck_files_to_queue: Re-enqueue files stuck in pending/processing state.
-- Use for operational recovery after outages or crashes.
CREATE OR REPLACE FUNCTION migrate_stuck_files_to_queue()
RETURNS TABLE(file_id UUID, file_path TEXT, enqueued BOOLEAN) AS $$
BEGIN
  RETURN QUERY
  WITH stuck_files AS (
    SELECT id, path FROM files
    WHERE chunks_status IN ('pending', 'processing')
  )
  SELECT
    sf.id AS file_id,
    sf.path AS file_path,
    (pgmq.send(
      queue_name := 'embeddings_queue',
      message    := jsonb_build_object(
        'file_id',     sf.id,
        'file_path',   sf.path,
        'batch_size',  20,
        'enqueued_at', now(),
        'migrated',    true
      )
    ) IS NOT NULL) AS enqueued
  FROM stuck_files sf;
END;
$$ LANGUAGE plpgsql;

-- migrate_stuck_intelligence_files: Re-enqueue files stuck in intelligence pipeline.
CREATE OR REPLACE FUNCTION migrate_stuck_intelligence_files()
RETURNS TABLE(file_id UUID, file_path TEXT, enqueued BOOLEAN) AS $$
BEGIN
  RETURN QUERY
  WITH stuck_files AS (
    SELECT id, path FROM files
    WHERE intelligence_status IN ('pending', 'processing')
  )
  SELECT
    sf.id AS file_id,
    sf.path AS file_path,
    (pgmq.send(
      queue_name := 'intelligence_queue',
      message    := jsonb_build_object(
        'file_id',        sf.id,
        'file_path',      sf.path,
        'content_length', length(f.body),
        'enqueued_at',    now(),
        'migrated',       true
      )
    ) IS NOT NULL) AS enqueued
  FROM stuck_files sf
  JOIN files f ON f.id = sf.id;
END;
$$ LANGUAGE plpgsql;

-- migrate_stuck_extraction_files: Re-enqueue files stuck in extraction pipeline.
CREATE OR REPLACE FUNCTION migrate_stuck_extraction_files()
RETURNS TABLE(file_id UUID, file_path TEXT, enqueued BOOLEAN) AS $$
BEGIN
  RETURN QUERY
  WITH stuck_files AS (
    SELECT id, path FROM files
    WHERE extraction_status IN ('queued', 'processing')
  )
  SELECT
    sf.id AS file_id,
    sf.path AS file_path,
    (pgmq.send(
      queue_name := 'extraction_queue',
      message    := jsonb_build_object(
        'file_id',     sf.id,
        'file_path',   sf.path,
        'enqueued_at', now(),
        'migrated',    true
      )
    ) IS NOT NULL) AS enqueued
  FROM stuck_files sf;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION migrate_stuck_extraction_files IS 'Re-enqueue stuck extraction files for recovery';

-- ===================================================================
-- SECTION 9: pgmq Queues and Triggers
-- ===================================================================

-- Create the three async processing queues
SELECT pgmq.create('extraction_queue');
SELECT pgmq.create('intelligence_queue');
SELECT pgmq.create('embeddings_queue');

-- Trigger: auto-enqueue files needing extraction (large uploads via Gemini File API)
DROP TRIGGER IF EXISTS on_file_needs_extraction ON files;
CREATE TRIGGER on_file_needs_extraction
  AFTER INSERT OR UPDATE OF extraction_status ON files
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_for_extraction();

-- Trigger: auto-enqueue files for intelligence after extraction completes
DROP TRIGGER IF EXISTS on_file_needs_intelligence ON files;
CREATE TRIGGER on_file_needs_intelligence
  AFTER INSERT OR UPDATE OF intelligence_status ON files
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_for_intelligence();

-- Trigger: auto-enqueue files for embeddings after intelligence completes
DROP TRIGGER IF EXISTS on_file_needs_embeddings ON files;
CREATE TRIGGER on_file_needs_embeddings
  AFTER INSERT OR UPDATE OF chunks_status ON files
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_for_embedding();

-- Grant permissions for Edge Functions and service role to access queues via RPC
GRANT USAGE ON SCHEMA pgmq TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA pgmq TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgmq TO anon, authenticated, service_role;

-- Public wrapper functions for pgmq operations accessible via /rest/v1/rpc/*
CREATE OR REPLACE FUNCTION public.queue_read(queue_name TEXT, vt INTEGER, qty INTEGER)
RETURNS SETOF pgmq.message_record AS $$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.read(queue_name, vt, qty);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.queue_send(queue_name TEXT, msg JSONB)
RETURNS BIGINT AS $$
BEGIN
  RETURN pgmq.send(queue_name, msg);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.queue_delete(queue_name TEXT, msg_id BIGINT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN pgmq.delete(queue_name, msg_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.queue_archive(queue_name TEXT, msg_id BIGINT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN pgmq.archive(queue_name, msg_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Monitoring views for queue health (queue depth, message age)
CREATE OR REPLACE VIEW extraction_queue_health AS
SELECT queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages
FROM pgmq.metrics('extraction_queue');

CREATE OR REPLACE VIEW intelligence_queue_health AS
SELECT queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages
FROM pgmq.metrics('intelligence_queue');

CREATE OR REPLACE VIEW embeddings_queue_health AS
SELECT queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages
FROM pgmq.metrics('embeddings_queue');

COMMENT ON VIEW extraction_queue_health IS 'Monitor extraction queue depth and message age';
COMMENT ON VIEW intelligence_queue_health IS 'Monitor intelligence queue depth and message age';
COMMENT ON VIEW embeddings_queue_health IS 'Monitor embeddings queue depth and message age';
