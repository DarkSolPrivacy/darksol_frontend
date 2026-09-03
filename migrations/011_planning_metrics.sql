CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_asset_time
  ON pool_flows(protocol, asset, block_time DESC);

CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_asset_type_time
  ON pool_flows(protocol, asset, flow_type, block_time DESC);
