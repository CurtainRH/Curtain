-- Indexer bookkeeping and public aggregates (docs/Curtain_Backend.md §3: "TVL per token,
-- tx counts, broadcaster stats, provider freshness"). Still no table links a note to an
-- address, an amount, or another note.

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS tvl NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS flag_root TEXT;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS indexer_cursor (
  id     INTEGER PRIMARY KEY,
  block  BIGINT NOT NULL
);

-- Daily counts per kind: shield | transact | unshield | unshield_to_origin | relay
CREATE TABLE IF NOT EXISTS activity (
  day    DATE NOT NULL,
  kind   TEXT NOT NULL,
  count  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
