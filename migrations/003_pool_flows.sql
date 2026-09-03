CREATE TABLE IF NOT EXISTS pool_flows (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL REFERENCES source_transactions(signature) ON DELETE CASCADE,
  instruction_index TEXT NOT NULL,
  block_time INTEGER NOT NULL,
  participant TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  amount_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  amount REAL NOT NULL,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS pool_flows_block_time_idx
  ON pool_flows (block_time DESC);

CREATE INDEX IF NOT EXISTS pool_flows_asset_direction_time_idx
  ON pool_flows (asset, direction, block_time DESC);
