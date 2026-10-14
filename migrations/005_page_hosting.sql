-- Landing page hosting. Files live in Postgres so they survive redeploys
-- (Render's filesystem is ephemeral). Identical files are stored once.

CREATE TABLE page_blobs (
  sha256 TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size INT NOT NULL CHECK (size >= 0),
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each upload is an immutable version; publishing points the page at one.
CREATE TABLE page_versions (
  id BIGSERIAL PRIMARY KEY,
  landing_page_id BIGINT NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  entry_path TEXT NOT NULL,
  file_count INT NOT NULL,
  total_bytes BIGINT NOT NULL,
  report JSONB NOT NULL DEFAULT '{}',
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX page_versions_page_idx ON page_versions (landing_page_id, id DESC);

CREATE TABLE page_files (
  version_id BIGINT NOT NULL REFERENCES page_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 300),
  content_type TEXT NOT NULL,
  size INT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES page_blobs(sha256),
  PRIMARY KEY (version_id, path)
);

ALTER TABLE landing_pages
  ADD CONSTRAINT landing_pages_published_version_fk
    FOREIGN KEY (published_version_id) REFERENCES page_versions(id) ON DELETE SET NULL,
  ADD COLUMN domain_status TEXT,
  ADD COLUMN domain_checked_at TIMESTAMPTZ;
