-- Campaign names belong to a game master, not to the installation.
--
-- 001 declared `campaigns.name` UNIQUE outright, which made every game master on
-- a deployment share one namespace: the second table to run a Champions game
-- could not call it "Champions". Names exist so a game master can tell their own
-- library apart, and nobody sees another's, so the scope was wrong.
--
-- A column-level UNIQUE is enforced by an implicit `sqlite_autoindex`, which
-- cannot be dropped, so the table has to be rebuilt. The usual recipe turns
-- foreign keys off around the rebuild, but this runner applies each file inside a
-- transaction and `PRAGMA foreign_keys` is a no-op there. `legacy_alter_table`
-- can be set inside one, and it is what makes the rename safe: without it the
-- rename would rewrite `characters` and `game_sessions` to reference
-- `campaigns_old`, and with it they keep pointing at the name `campaigns`, which
-- is the table being put back. Nothing then references `campaigns_old`, so
-- dropping it cascades to nothing.
--
-- No rows need fixing up: per-game-master uniqueness admits everything the old
-- constraint did.

PRAGMA legacy_alter_table = ON;

ALTER TABLE campaigns RENAME TO campaigns_old;

CREATE TABLE campaigns (
  id             TEXT PRIMARY KEY,
  gm_id          TEXT NOT NULL REFERENCES gms(id) ON DELETE CASCADE,
  name           TEXT NOT NULL COLLATE NOCASE,
  card_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

INSERT INTO campaigns (id, gm_id, name, card_upload_id, created_at, updated_at)
SELECT id, gm_id, name, card_upload_id, created_at, updated_at FROM campaigns_old;

DROP TABLE campaigns_old;

CREATE INDEX idx_campaigns_gm ON campaigns(gm_id);

-- One name per game master, the way characters are named within a campaign and
-- templates within a collection.
CREATE UNIQUE INDEX idx_campaigns_gm_name ON campaigns(gm_id, name COLLATE NOCASE);

PRAGMA legacy_alter_table = OFF;
