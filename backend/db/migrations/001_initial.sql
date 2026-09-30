-- Core public-aggregate tables (docs/Curtain_Backend.md §3.1).
-- No table maps a note to an address, amount, or another note.

CREATE TABLE IF NOT EXISTS tokens (
  addr        TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  is8056      BOOLEAN NOT NULL DEFAULT false,
  multiplier  NUMERIC NOT NULL,
  next_mult   NUMERIC,
  next_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS commitments (
  leaf_index     BIGINT PRIMARY KEY,
  commit         TEXT NOT NULL UNIQUE,
  block          BIGINT NOT NULL,
  shielded_at    TIMESTAMPTZ NOT NULL,
  standby_until  TIMESTAMPTZ NOT NULL,
  cleared        BOOLEAN NOT NULL DEFAULT false,
  flagged        BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS providers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  root        TEXT,
  updated_at  TIMESTAMPTZ,
  stale       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS broadcasters (
  addr            TEXT PRIMARY KEY,
  bond            NUMERIC NOT NULL,
  fee_bps         INTEGER NOT NULL,
  gas_markup_bps  INTEGER NOT NULL DEFAULT 0,
  submitted       INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  uptime_30d      NUMERIC
);

CREATE TABLE IF NOT EXISTS recipes (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  version  TEXT NOT NULL,
  targets  TEXT[] NOT NULL DEFAULT '{}',
  audited  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS solvency (
  epoch         BIGINT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  token         TEXT NOT NULL,
  pool_balance  NUMERIC NOT NULL,
  live_notes    NUMERIC NOT NULL,
  tx            TEXT,
  PRIMARY KEY (epoch, token)
);
