-- Postgres schema for the analytics database.
--
-- This is not a column-for-column copy of the thirteen SQLite migrations under
-- ../migrations, which are kept only as the lineage the local database was
-- built from. Everything that no read path consumes has been left out:
--
--   * source_transactions   the raw payload column was ~95% of the dataset's
--                           bytes and had no reader at all; the rest of the
--                           table served three aggregates that pool_flows can
--                           answer itself, so the table is gone entirely
--   * deposits              a cloakc-only mirror of the deposit rows already in
--                           pool_flows, written every batch and never read
--   * decimals              every consumer derives decimals from the asset
--   * instruction_index     recoverable from id, which is signature:index
--   * indexed_at            never read on any row
--   * sync_state.last_block_time / last_signature
--                           written by the old schema, read by nothing
--
-- pool_flows is the analytics table and keeps every column: participant drives
-- PrivacyCash swap matching, amount_raw drives the distinct-amount metrics, and
-- linked_flow_id drives swap pairing and latency.

CREATE TABLE IF NOT EXISTS pool_flows (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  block_time BIGINT NOT NULL,
  participant TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  amount_raw TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'cloakc',
  flow_type TEXT,
  counter_asset TEXT,
  linked_flow_id TEXT
);

-- One index per query this table actually serves. The SQLite lineage had grown
-- ten of them, several never reachable: nothing filters block_time, asset or
-- direction without also filtering protocol, and participant is grouped in
-- memory after a time-range fetch rather than sought on.
--   readFlows, databaseStats, readProtocolHistoryBounds, and the range scan in
--   classifyPrivacyCashSwaps
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_time
  ON pool_flows (protocol, block_time DESC);
--   readPlanningFlows
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_asset_time
  ON pool_flows (protocol, asset, block_time DESC);
--   the swap_out scan behind readLinkedFlowLatencies
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_type_time
  ON pool_flows (protocol, flow_type, block_time DESC);
--   classifyPrivacyCashSwaps resolves linked_flow_id in both directions
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_linked_flow
  ON pool_flows (protocol, linked_flow_id);
--   the per-transaction replacement delete every indexed batch performs, which
--   the SQLite schema never had an index for at all
CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_signature
  ON pool_flows (protocol, signature);

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
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
  amount DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (protocol, asset, block_time)
);

CREATE INDEX IF NOT EXISTS idx_pool_snapshots_protocol_time
  ON pool_snapshots (protocol, block_time DESC);

CREATE TABLE IF NOT EXISTS token_prices (
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  block_time BIGINT NOT NULL,
  usd_price DOUBLE PRECISION NOT NULL CHECK (usd_price > 0),
  -- Kept as provenance for a price that feeds every USD figure; this table is
  -- a few hundred rows, so the column costs nothing.
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

-- Flows are retained for a rolling window (see FLOW_RETENTION_DAYS); the chart
-- never looks back further than 90 days. Cloak's pool balance, however, is
-- reconstructed by summing every flow since the pool opened, so pruning a row
-- would silently move its TVL. Before any flow is deleted its contribution is
-- folded in here, and the balance becomes this baseline plus the flows still
-- present. PrivacyCash and Curvy read their balances on-chain and do not depend
-- on it, but the baseline is maintained for every protocol so the reconstructed
-- figure stays available as a cross-check.
CREATE TABLE IF NOT EXISTS flow_baselines (
  protocol TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  -- Signed: deposits minus withdrawals across every pruned flow.
  net_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  deposit_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  withdraw_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  flow_count BIGINT NOT NULL DEFAULT 0,
  -- Every flow at or before this timestamp is accounted for in the totals above
  -- rather than in pool_flows.
  through_block_time BIGINT NOT NULL,
  PRIMARY KEY (protocol, asset)
);
