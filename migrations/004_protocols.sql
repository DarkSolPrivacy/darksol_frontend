ALTER TABLE source_transactions ADD COLUMN protocol TEXT NOT NULL DEFAULT 'cloakc';
ALTER TABLE pool_flows ADD COLUMN protocol TEXT NOT NULL DEFAULT 'cloakc';

CREATE INDEX IF NOT EXISTS idx_source_transactions_protocol_time
  ON source_transactions(protocol, block_time DESC);

CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_time
  ON pool_flows(protocol, block_time DESC);

CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_direction_time
  ON pool_flows(protocol, direction, block_time DESC);
