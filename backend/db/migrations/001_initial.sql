-- Curtain v2 operator database (docs/CURTAIN_V2_SPEC.md). Every state change of an intent
-- (deposit seen, swapped, payout signed, paid, refund requested, refunded) happens in one
-- transaction together with the rows it touches.

CREATE TABLE intents (
  id               TEXT PRIMARY KEY,                -- random, returned to the user
  deadline_hash    TEXT NOT NULL UNIQUE,            -- keccak256(abi.encode(deadline, salt)), on-chain at deposit
  deadline         BIGINT NOT NULL,                 -- unix seconds; payouts must land before it
  salt             TEXT NOT NULL,
  pay_at           BIGINT NOT NULL,                 -- scheduled payout time (random inside the window)
  mode             TEXT NOT NULL CHECK (mode IN ('instant', 'delayed')),
  token_in         TEXT NOT NULL,
  amount_in        NUMERIC NOT NULL,
  token_out        TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  min_out          NUMERIC NOT NULL,
  secret           TEXT NOT NULL,                   -- payout tag = keccak256(abi.encode(depositId, secret))
  status           TEXT NOT NULL DEFAULT 'awaiting_deposit' CHECK (status IN (
                     'awaiting_deposit', 'deposited', 'swapping', 'payout_signed', 'paid',
                     'refund_requested', 'refunded', 'challenged', 'expired')),
  deposit_id       BIGINT UNIQUE,
  depositor        TEXT,
  deposited_amount NUMERIC,
  batch_id         BIGINT,
  amount_out       NUMERIC,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX intents_due ON intents (status, pay_at);

CREATE TABLE batches (
  id          BIGSERIAL PRIMARY KEY,
  token_in    TEXT NOT NULL,
  token_out   TEXT NOT NULL,
  amount_in   NUMERIC NOT NULL,
  min_out     NUMERIC NOT NULL,
  amount_out  NUMERIC,
  tx_hash     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payouts (
  id            BIGSERIAL PRIMARY KEY,
  intent_id     TEXT NOT NULL REFERENCES intents(id),
  nonce         NUMERIC NOT NULL UNIQUE,
  recipient     TEXT NOT NULL,
  token         TEXT NOT NULL,
  amount        NUMERIC NOT NULL,
  protocol_fee  NUMERIC NOT NULL,
  keeper_fee    NUMERIC NOT NULL,
  deadline      BIGINT NOT NULL,                    -- signature expiry, never after the intent's deadline
  tag           TEXT NOT NULL UNIQUE,
  signature     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'signed' CHECK (status IN ('signed', 'confirmed', 'expired')),
  tx_hash       TEXT,
  keeper        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chain_cursor (
  id     INTEGER PRIMARY KEY,
  block  BIGINT NOT NULL
);
