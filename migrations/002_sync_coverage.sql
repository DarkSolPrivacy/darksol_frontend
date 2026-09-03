ALTER TABLE sync_state ADD COLUMN backfilled_from INTEGER;
ALTER TABLE sync_state ADD COLUMN synced_through INTEGER;
