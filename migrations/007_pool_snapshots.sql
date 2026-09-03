CREATE TABLE IF NOT EXISTS pool_snapshots (
  protocol TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  block_time INTEGER NOT NULL,
  amount_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  amount REAL NOT NULL,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (protocol, asset, block_time)
);

CREATE INDEX IF NOT EXISTS idx_pool_snapshots_protocol_time
  ON pool_snapshots(protocol, block_time DESC);
