ALTER TABLE pool_flows ADD COLUMN flow_type TEXT;
ALTER TABLE pool_flows ADD COLUMN counter_asset TEXT;
ALTER TABLE pool_flows ADD COLUMN linked_flow_id TEXT;

UPDATE pool_flows SET flow_type = direction WHERE flow_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_pool_flows_protocol_type_time
  ON pool_flows(protocol, flow_type, block_time DESC);

CREATE TABLE IF NOT EXISTS token_prices (
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'SOL', 'USDT')),
  block_time INTEGER NOT NULL,
  usd_price REAL NOT NULL CHECK (usd_price > 0),
  source TEXT NOT NULL,
  PRIMARY KEY (asset, block_time)
);

CREATE INDEX IF NOT EXISTS idx_token_prices_asset_time
  ON token_prices(asset, block_time DESC);
