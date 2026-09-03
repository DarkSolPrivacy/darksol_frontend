-- PrivacyCash publicAmount is a 32-byte field element. Flow volume comes from
-- the signed i64 extAmount later in the transact payload, so rebuild any rows
-- produced by the earlier decoder.
DELETE FROM pool_flows WHERE protocol = 'privacycash';
