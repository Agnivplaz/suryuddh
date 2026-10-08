-- =====================================================================
--  Sur Yuddh — schema (PostgreSQL flavour: Supabase / Neon / Railway / VPS)
--  Run once against your database:
--    psql "$DATABASE_URL" -f src/db/schema.postgres.sql
--  (the server also self-applies this on boot when DB_AUTO_MIGRATE is on)
-- =====================================================================

CREATE TABLE IF NOT EXISTS players (
  id              UUID PRIMARY KEY,
  username        TEXT NOT NULL,
  username_lower  TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  total_xp        INTEGER NOT NULL DEFAULT 0,
  games_played    INTEGER NOT NULL DEFAULT 0,
  wins            INTEGER NOT NULL DEFAULT 0,
  losses          INTEGER NOT NULL DEFAULT 0,
  draws           INTEGER NOT NULL DEFAULT 0,
  trust_score     INTEGER NOT NULL DEFAULT 100,
  banned          BOOLEAN NOT NULL DEFAULT false,
  created_at      BIGINT NOT NULL,
  last_seen       BIGINT NOT NULL,
  CONSTRAINT players_username_shape CHECK (username ~ '^[A-Za-z0-9_]{3,16}$')
);
CREATE INDEX IF NOT EXISTS idx_players_leaderboard
  ON players (banned, total_xp DESC, wins DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS matches (
  id              UUID PRIMARY KEY,
  mode            TEXT NOT NULL DEFAULT 'ranked_1v1',
  room_code       TEXT,
  status          TEXT NOT NULL DEFAULT 'live',
  winner_id       UUID REFERENCES players(id),
  loser_id        UUID REFERENCES players(id),
  win_reason      TEXT,
  result_source   TEXT,
  validated       BOOLEAN NOT NULL DEFAULT false,
  validation_note TEXT,
  seed            BIGINT NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  started_at      BIGINT NOT NULL,
  ended_at        BIGINT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_started ON matches (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_room    ON matches (room_code);

CREATE TABLE IF NOT EXISTS match_players (
  match_id      UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  slot          SMALLINT NOT NULL,
  player_id     UUID NOT NULL REFERENCES players(id),
  username      TEXT NOT NULL,
  instrument    TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  xp_earned     INTEGER NOT NULL DEFAULT 0,
  damage_dealt  INTEGER NOT NULL DEFAULT 0,
  inputs_count  INTEGER NOT NULL DEFAULT 0,
  hp_left       INTEGER,
  disconnected  BOOLEAN NOT NULL DEFAULT false,
  client_claim  JSONB,
  PRIMARY KEY (match_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_match_players_player ON match_players (player_id, match_id);

CREATE TABLE IF NOT EXISTS xp_audit (
  id          BIGSERIAL PRIMARY KEY,
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id    UUID,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  xp_before   INTEGER NOT NULL,
  xp_after    INTEGER NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_audit_player_time ON xp_audit (player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rooms (
  room_code   TEXT PRIMARY KEY,
  host_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  guest_id    UUID REFERENCES players(id),
  status      TEXT NOT NULL DEFAULT 'open',
  match_id    UUID,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_host  ON rooms (host_id, status);
CREATE INDEX IF NOT EXISTS idx_rooms_guest ON rooms (guest_id, status);

CREATE TABLE IF NOT EXISTS match_replays (
  match_id    UUID PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  seed        BIGINT NOT NULL,
  host_slot   SMALLINT NOT NULL,
  frames      INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  input_log   JSONB,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  revoked_at  BIGINT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_player ON refresh_tokens (player_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS security_events (
  id         BIGSERIAL PRIMARY KEY,
  player_id  UUID,
  kind       TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_events_time ON security_events (created_at DESC);
