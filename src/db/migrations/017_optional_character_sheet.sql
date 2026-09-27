-- A character no longer needs a character file.
--
-- 001 declared `characters.sheet_upload_id` NOT NULL, because a character was an
-- uploaded sheet with a name on it. It is more than that now: the numbers a fight
-- is run from are columns of their own, and a card image is its own upload, so a
-- goblin typed straight into the dialog is a whole character that simply has no
-- sheet to open. A file can still be attached to it later, and that is when its
-- sheet appears.
--
-- SQLite cannot relax NOT NULL in place, so the table is rebuilt with the recipe
-- 016 used for `campaigns`, and for the same reason: `legacy_alter_table` keeps
-- `session_characters` and `players` referencing the name `characters` through
-- the rename, so nothing points at `characters_old` when it is dropped.

PRAGMA legacy_alter_table = ON;

ALTER TABLE characters RENAME TO characters_old;

CREATE TABLE characters (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('pc', 'npc')),
  -- NOCASE on the column, as 001 had it, so every comparison agrees with the
  -- uniqueness index below.
  name            TEXT NOT NULL COLLATE NOCASE,
  -- NULL for a character filed without a character file.
  sheet_upload_id TEXT REFERENCES uploads(id),
  card_upload_id  TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  speed           INTEGER NOT NULL DEFAULT 0,
  dexterity       INTEGER NOT NULL DEFAULT 0,
  recovery        INTEGER NOT NULL DEFAULT 0,
  endurance       INTEGER NOT NULL DEFAULT 0,
  stun            INTEGER NOT NULL DEFAULT 0,
  body            INTEGER NOT NULL DEFAULT 0,
  initiative      INTEGER NOT NULL DEFAULT 0,
  constitution    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

INSERT INTO characters
  (id, campaign_id, kind, name, sheet_upload_id, card_upload_id,
   speed, dexterity, recovery, endurance, stun, body, initiative, constitution,
   created_at, updated_at)
SELECT
   id, campaign_id, kind, name, sheet_upload_id, card_upload_id,
   speed, dexterity, recovery, endurance, stun, body, initiative, constitution,
   created_at, updated_at
FROM characters_old;

DROP TABLE characters_old;

CREATE INDEX idx_characters_campaign ON characters(campaign_id);
CREATE UNIQUE INDEX idx_characters_campaign_name ON characters(campaign_id, name COLLATE NOCASE);

PRAGMA legacy_alter_table = OFF;
