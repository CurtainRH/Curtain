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
  depositor        TEXT NOT NULL,                   -- deposits are matched on (depositor, deadline_hash)
  status           TEXT NOT NULL DEFAULT 'awaiting_deposit' CHECK (status IN (
                     'awaiting_deposit', 'deposited', 'settling', 'paid',
                     'refund_requested', 'refunded', 'challenged', 'expired', 'blocked')),
  blocked_reason   TEXT,                            -- why the output token refuses this recipient
  deposit_id       BIGINT UNIQUE,
  deposited_amount NUMERIC,
  settlement_id    BIGINT,
  amount_out       NUMERIC,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX intents_due ON intents (status, pay_at);

-- One operator-signed settlement: a swap of pooled funds plus the payouts it funds, landed
-- atomically by any keeper via CurtainVault.settle().
CREATE TABLE settlements (
  id          BIGSERIAL PRIMARY KEY,
  nonce       NUMERIC NOT NULL UNIQUE,
  token_in    TEXT NOT NULL,
  token_out   TEXT NOT NULL,
  amount_in   NUMERIC NOT NULL,
  min_out     NUMERIC NOT NULL,
  router      TEXT NOT NULL,
  swap_data   TEXT NOT NULL,
  deadline    BIGINT NOT NULL,                      -- never after any of its intents' deadlines
  signature   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'signed' CHECK (status IN ('signed', 'confirmed', 'expired')),
  tx_hash     TEXT,
  keeper      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payouts (
  id             BIGSERIAL PRIMARY KEY,
  settlement_id  BIGINT NOT NULL REFERENCES settlements(id),
  position       INTEGER NOT NULL,                  -- index in the settlement's payout array
  intent_id      TEXT NOT NULL REFERENCES intents(id),
  recipient      TEXT NOT NULL,
  amount         NUMERIC NOT NULL,
  protocol_fee   NUMERIC NOT NULL,
  keeper_fee     NUMERIC NOT NULL,
  tag            TEXT NOT NULL,
  UNIQUE (settlement_id, position)
);

CREATE TABLE chain_cursor (
  id     INTEGER PRIMARY KEY,
  block  BIGINT NOT NULL
);
