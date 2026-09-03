ALTER TABLE sync_state ADD COLUMN history_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN backfill_cursor TEXT;
ALTER TABLE sync_state ADD COLUMN backfill_upper_bound INTEGER;
ALTER TABLE sync_state ADD COLUMN incremental_cursor TEXT;
ALTER TABLE sync_state ADD COLUMN incremental_from INTEGER;
ALTER TABLE sync_state ADD COLUMN incremental_to INTEGER;

-- Existing sync rows are intentionally left unverified. The first run of the
-- new indexer performs one resumable reconciliation before setting this flag.

CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_participant_time
  ON pool_flows(protocol, participant, block_time);
