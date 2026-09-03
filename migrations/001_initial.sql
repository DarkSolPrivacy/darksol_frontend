CREATE TABLE IF NOT EXISTS source_transactions (
  signature TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  block_time INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS source_transactions_block_time_idx
  ON source_transactions (block_time DESC);

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL REFERENCES source_transactions(signature) ON DELETE CASCADE,
  instruction_index TEXT NOT NULL,
  block_time INTEGER NOT NULL,
  depositor TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  amount_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  amount REAL NOT NULL,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS deposits_block_time_idx
  ON deposits (block_time DESC);

CREATE INDEX IF NOT EXISTS deposits_asset_block_time_idx
  ON deposits (asset, block_time DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
  last_block_time INTEGER,
  last_signature TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
