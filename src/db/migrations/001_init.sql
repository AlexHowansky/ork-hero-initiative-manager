-- Initial schema for the HERO Initiative Manager.

-- Administrative users. Created only through the CLI; there is no account UI.
CREATE TABLE gms (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Browser sessions for signed-in GMs. Only the hash of the cookie token is kept.
CREATE TABLE gm_auth_sessions (
  id           TEXT PRIMARY KEY,
  gm_id        TEXT NOT NULL REFERENCES gms(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_gm_auth_sessions_gm ON gm_auth_sessions(gm_id);
CREATE INDEX idx_gm_auth_sessions_expiry ON gm_auth_sessions(expires_at);

-- Uploaded files. Stored on disk under a random name; never served statically.
CREATE TABLE uploads (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('sheet', 'image')),
  disk_path     TEXT NOT NULL,
  mime          TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  original_name TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE campaigns (
  id                   TEXT PRIMARY KEY,
  gm_id                TEXT NOT NULL REFERENCES gms(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  background_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_campaigns_gm ON campaigns(gm_id);

-- A PC or NPC. The character sheet itself is an uploaded HTML file.
CREATE TABLE characters (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('pc', 'npc')),
  -- NOCASE on the column, not just on the index below, so that every comparison
  -- anywhere agrees with the uniqueness constraint.
  name                 TEXT NOT NULL COLLATE NOCASE,
  sheet_upload_id      TEXT NOT NULL REFERENCES uploads(id),
  background_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_characters_campaign ON characters(campaign_id);
-- Character names are unique within their campaign so players can tell them apart.
CREATE UNIQUE INDEX idx_characters_campaign_name ON characters(campaign_id, name COLLATE NOCASE);

-- A single sitting. Multiple sessions may be active at once.
CREATE TABLE game_sessions (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  gm_id               TEXT NOT NULL REFERENCES gms(id) ON DELETE CASCADE,
  code                TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  -- Whose turn it currently is, or NULL before the first turn is set.
  active_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  round               INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  ended_at            TEXT
);
CREATE INDEX idx_game_sessions_campaign ON game_sessions(campaign_id);
CREATE INDEX idx_game_sessions_gm_status ON game_sessions(gm_id, status);

-- Which characters the GM has made active in a session, and in what initiative
-- order. `position` is kept dense (0..n-1) by the reorder/add/remove handlers.
CREATE TABLE session_characters (
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  added_at        TEXT NOT NULL,
  PRIMARY KEY (game_session_id, character_id)
);
CREATE INDEX idx_session_characters_order ON session_characters(game_session_id, position);

-- Someone who joined a session with the code. Identity lives for the session only.
CREATE TABLE players (
  id                   TEXT PRIMARY KEY,
  game_session_id      TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL COLLATE NOCASE,
  token_hash           TEXT NOT NULL UNIQUE,
  claimed_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  joined_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_players_session_name ON players(game_session_id, name COLLATE NOCASE);
-- A PC can be held by at most one player in a given session.
CREATE UNIQUE INDEX idx_players_session_claim
  ON players(game_session_id, claimed_character_id)
  WHERE claimed_character_id IS NOT NULL;
