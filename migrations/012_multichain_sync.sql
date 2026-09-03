ALTER TABLE sync_state ADD COLUMN chain_cursor TEXT;

CREATE INDEX IF NOT EXISTS idx_source_transactions_protocol_slot
  ON source_transactions(protocol, slot DESC);
