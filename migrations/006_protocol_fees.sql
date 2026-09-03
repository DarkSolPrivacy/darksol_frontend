CREATE TABLE IF NOT EXISTS protocol_fees (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  signature TEXT NOT NULL REFERENCES source_transactions(signature) ON DELETE CASCADE,
  instruction_index TEXT NOT NULL,
  block_time INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'charged',
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  amount_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  amount REAL NOT NULL,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_protocol_fees_protocol_time
  ON protocol_fees(protocol, block_time DESC);

-- PrivacyCash withdrawals must be rebuilt because their pool outflow is the
-- recipient amount plus the separately encoded fee.
DELETE FROM pool_flows WHERE protocol = 'privacycash';
