-- =====================================================================
--  Sur Yuddh — schema (SQLite flavour, used for local dev + LAN demos)
--  Every timestamp is epoch milliseconds (INTEGER) — see docs/03-SYSTEM-DESIGN.md
-- =====================================================================

CREATE TABLE IF NOT EXISTS players (
  id              TEXT    PRIMARY KEY,              -- UUID v4, the internal identity
  username        TEXT    NOT NULL,                 -- display name (public identity)
  username_lower  TEXT    NOT NULL UNIQUE,          -- case-insensitive uniqueness
  password_hash   TEXT    NOT NULL,                 -- bcrypt
  total_xp        INTEGER NOT NULL DEFAULT 0,       -- leaderboard metric (server-only writes)
  games_played    INTEGER NOT NULL DEFAULT 0,
  wins            INTEGER NOT NULL DEFAULT 0,
  losses          INTEGER NOT NULL DEFAULT 0,
  draws           INTEGER NOT NULL DEFAULT 0,
  trust_score     INTEGER NOT NULL DEFAULT 100,     -- anti-cheat health of the account
  banned          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_leaderboard
  ON players (banned, total_xp DESC, wins DESC, created_at ASC);

-- One row per match. `matches` = the match-level record,
-- `match_players` = per-player detail (instrument, xp, outcome, stats).
CREATE TABLE IF NOT EXISTS matches (
  id              TEXT PRIMARY KEY,
  mode            TEXT NOT NULL DEFAULT 'ranked_1v1',   -- ranked_1v1 | friendly
  room_code       TEXT,                                 -- NULL for Quick Match
  status          TEXT NOT NULL DEFAULT 'live',         -- live | finished | void
  winner_id       TEXT REFERENCES players(id),
  loser_id        TEXT REFERENCES players(id),
  win_reason      TEXT,                                 -- ko | disconnect | forfeit | timeout
  result_source   TEXT,                                 -- both_agree | loser_disconnect | server_decided
  validated       INTEGER NOT NULL DEFAULT 0,
  validation_note TEXT,
  seed            INTEGER NOT NULL DEFAULT 0,           -- deterministic sim seed
  duration_ms     INTEGER,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_player1 ON matches (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_room    ON matches (room_code);

CREATE TABLE IF NOT EXISTS match_players (
  match_id      TEXT    NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  slot          INTEGER NOT NULL,                  -- 1 = host (sim authority), 2 = guest
  player_id     TEXT    NOT NULL REFERENCES players(id),
  username      TEXT    NOT NULL,                  -- snapshot for history rendering
  instrument    TEXT    NOT NULL,                  -- 'tabla', 'sitar', ...
  outcome       TEXT    NOT NULL,                  -- win | loss | draw | void
  xp_earned     INTEGER NOT NULL DEFAULT 0,
  damage_dealt  INTEGER NOT NULL DEFAULT 0,
  inputs_count  INTEGER NOT NULL DEFAULT 0,
  hp_left       INTEGER,
  disconnected  INTEGER NOT NULL DEFAULT 0,
  client_claim  TEXT,                              -- raw JSON the client claimed (audit)
  PRIMARY KEY (match_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_match_players_player ON match_players (player_id, match_id);

-- Append-only XP ledger. total_xp on players is derived from this table;
-- anything unexplained here is a bug or an attack.
CREATE TABLE IF NOT EXISTS xp_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id    TEXT,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,                       -- ranked_win | ranked_loss | daily_cap_trim | admin_adjust
  xp_before   INTEGER NOT NULL,
  xp_after    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_audit_player_time ON xp_audit (player_id, created_at DESC);

-- Pending room codes (the DB is the source of truth; memory is just a cache).
CREATE TABLE IF NOT EXISTS rooms (
  room_code   TEXT PRIMARY KEY,
  host_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  guest_id    TEXT REFERENCES players(id),
  status      TEXT NOT NULL DEFAULT 'open',        -- open | matched | live | closed | expired
  match_id    TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_host  ON rooms (host_id, status);
CREATE INDEX IF NOT EXISTS idx_rooms_guest ON rooms (guest_id, status);

-- Compact input log, kept so the server can re-simulate / audit a match later
-- (see docs/03-SYSTEM-DESIGN.md → "server-authoritative replay validation").
CREATE TABLE IF NOT EXISTS match_replays (
  match_id    TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  seed        INTEGER NOT NULL,
  host_slot   INTEGER NOT NULL,
  frames      INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  input_log   TEXT,                                 -- JSON: {"1":[[t,x,z,mask]...],"2":[...]}
  created_at  INTEGER NOT NULL
);

-- Refresh tokens (rotating). Access tokens are stateless JWTs.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash  TEXT PRIMARY KEY,                     -- sha256 of the opaque token
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_player ON refresh_tokens (player_id, expires_at DESC);

-- Server-side event log: auth failures, rejected results, suspicious input, ...
CREATE TABLE IF NOT EXISTS security_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT,
  kind       TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_events_time ON security_events (created_at DESC);
