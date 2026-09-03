-- Consolidated Postgres schema. This is the final shape of the thirteen SQLite
-- migrations under ../migrations, which stay in the repo as the lineage for the
-- local database the one-time import reads from. Intermediate steps that only
-- rebuilt mis-decoded rows (005, 006) or dropped protocol_fees (008) are not
-- replayed here because a fresh Supabase database has nothing to rebuild.

CREATE TABLE IF NOT EXISTS source_transactions (
  signature TEXT PRIMARY KEY,
  slot BIGINT NOT NULL,
  block_time BIGINT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'cloakc',
  indexed_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);

CREATE INDEX IF NOT EXISTS source_transactions_block_time_idx
  ON source_transactions (block_time DESC);
CREATE INDEX IF NOT EXISTS idx_source_transactions_protocol_time
  ON source_transactions (protocol, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_source_transactions_protocol_slot
  ON source_transactions (protocol, slot DESC);

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL REFERENCES source_transactions(signature) ON DELETE CASCADE,
  instruction_index TEXT NOT NULL,
  block_time BIGINT NOT NULL,
  depositor TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  amount_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  indexed_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);

CREATE INDEX IF NOT EXISTS deposits_block_time_idx ON deposits (block_time DESC);
CREATE INDEX IF NOT EXISTS deposits_asset_block_time_idx ON deposits (asset, block_time DESC);

CREATE TABLE IF NOT EXISTS pool_flows (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL REFERENCES source_transactions(signature) ON DELETE CASCADE,
  instruction_index TEXT NOT NULL,
  block_time BIGINT NOT NULL,
  participant TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  amount_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'cloakc',
  flow_type TEXT,
  counter_asset TEXT,
  linked_flow_id TEXT,
  indexed_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);

CREATE INDEX IF NOT EXISTS pool_flows_block_time_idx ON pool_flows (block_time DESC);
CREATE INDEX IF NOT EXISTS pool_flows_asset_direction_time_idx ON pool_flows (asset, direction, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_time ON pool_flows (protocol, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_direction_time ON pool_flows (protocol, direction, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_type_time ON pool_flows (protocol, flow_type, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_participant_time ON pool_flows (protocol, participant, block_time);
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_asset_time ON pool_flows (protocol, asset, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_asset_type_time ON pool_flows (protocol, asset, flow_type, block_time DESC);
-- classifyPrivacyCashSwaps resolves linked_flow_id in both directions.
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_linked_flow ON pool_flows (protocol, linked_flow_id);

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
  last_block_time BIGINT,
  last_signature TEXT,
  backfilled_from BIGINT,
  synced_through BIGINT,
  history_complete BOOLEAN NOT NULL DEFAULT false,
  backfill_cursor TEXT,
  backfill_upper_bound BIGINT,
  incremental_cursor TEXT,
  incremental_from BIGINT,
  incremental_to BIGINT,
  chain_cursor TEXT,
  source_identity TEXT,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);

CREATE TABLE IF NOT EXISTS pool_snapshots (
  protocol TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  block_time BIGINT NOT NULL,
  amount_raw TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  indexed_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint,
  PRIMARY KEY (protocol, asset, block_time)
);

CREATE INDEX IF NOT EXISTS idx_pool_snapshots_protocol_time
  ON pool_snapshots (protocol, block_time DESC);

CREATE TABLE IF NOT EXISTS token_prices (
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  block_time BIGINT NOT NULL,
  usd_price DOUBLE PRECISION NOT NULL CHECK (usd_price > 0),
  source TEXT NOT NULL,
  PRIMARY KEY (asset, block_time)
);

CREATE INDEX IF NOT EXISTS idx_token_prices_asset_time
  ON token_prices (asset, block_time DESC);

-- Records that a given local SQLite file has been copied across, keyed by the
-- per-table row counts it had at the time. Comparing counts against Postgres
-- would be wrong once the indexer starts writing rows that never existed
-- locally, so completion is recorded explicitly instead of inferred.
CREATE TABLE IF NOT EXISTS local_import_state (
  path TEXT PRIMARY KEY,
  row_counts JSONB NOT NULL,
  imported_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);
