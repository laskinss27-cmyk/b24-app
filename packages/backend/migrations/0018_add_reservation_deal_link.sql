ALTER TABLE stock_reservations
    ADD COLUMN deal_id BIGINT UNSIGNED NULL AFTER source_revision_key,
	ADD COLUMN deal_link_explicit TINYINT(1) NOT NULL DEFAULT 0 AFTER deal_id,
    ADD COLUMN purpose VARCHAR(500) NULL AFTER deal_link_explicit,
    ADD KEY ix_stock_reservations_deal_status_expiry (deal_id, status, expires_at),
    DROP CONSTRAINT chk_stock_reservations_source_type,
    ADD CONSTRAINT chk_stock_reservations_source_type CHECK (source_type IN ('deal', 'manual', 'transfer', 'marketplace', 'presale_repair', 'legacy')),
    DROP CONSTRAINT chk_stock_reservations_expiry,
    ADD CONSTRAINT chk_stock_reservations_expiry CHECK ((source_type IN ('deal', 'manual') AND expires_at IS NOT NULL AND expires_at > approved_at) OR (source_type NOT IN ('deal', 'manual') AND expires_at IS NULL)),
	ADD CONSTRAINT chk_stock_reservations_deal_link CHECK (deal_link_explicit IN (0, 1) AND (deal_link_explicit = 1 OR deal_id IS NULL));
