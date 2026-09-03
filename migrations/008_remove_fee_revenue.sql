-- The dashboard exposes each protocol's published fee policy, not revenue
-- analytics. PrivacyCash's encoded fee is still used when calculating gross
-- pool outflow, but individual fee earnings are intentionally not persisted.
DROP TABLE IF EXISTS protocol_fees;
