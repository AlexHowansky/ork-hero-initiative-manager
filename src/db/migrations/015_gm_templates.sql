-- Export templates a game master has uploaded.
--
-- A character sheet is rendered by applying a HERO Designer export template to
-- the stored `.hdc`. Until now that template was one file for the whole
-- deployment, hardcoded in `server/hero-sheet.ts`; this is where the ones a game
-- master uploads are recorded.
--
-- A table of its own rather than a third `uploads.kind`, for three reasons. The
-- `uploads.kind` CHECK admits only 'sheet' and 'image', and SQLite cannot alter
-- a CHECK without rebuilding the table. `uploads.orphaned()` is an allowlist of
-- the three columns that reference an upload, and it runs on nearly every
-- character and campaign edit — a template row would be swept away within
-- minutes of being uploaded. And an `uploads` row deliberately has no owner,
-- because a file is not the thing that is owned; a template is, since each game
-- master keeps their own collection rather than sharing a pool.
CREATE TABLE templates (
  id            TEXT PRIMARY KEY,
  gm_id         TEXT NOT NULL REFERENCES gms(id) ON DELETE CASCADE,
  -- What the template calls itself, from its own `<!--TEMPLATE_NAME-->`.
  name          TEXT NOT NULL COLLATE NOCASE,
  original_name TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One name per game master, because a re-upload under a name they already have
-- is that template being *updated* rather than a second copy of it: the row
-- keeps its id, so a template that was in use stays in use across the update.
CREATE UNIQUE INDEX idx_templates_gm_name ON templates(gm_id, name COLLATE NOCASE);

-- Which one their sheets are drawn with. NULL is the template this app ships,
-- which is what a fresh install, a game master who has never chosen, and one
-- whose choice has gone all mean — and it is the only value that needs no row to
-- exist. Deleting the template in use is refused by the route rather than left
-- to `ON DELETE SET NULL`, which is here for the cascade that takes a game
-- master's templates with them.
ALTER TABLE gms ADD COLUMN template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;
