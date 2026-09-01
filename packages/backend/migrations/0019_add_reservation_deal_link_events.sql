ALTER TABLE stock_reservation_events
    ADD COLUMN from_deal_id BIGINT UNSIGNED NULL AFTER to_status,
    ADD COLUMN to_deal_id BIGINT UNSIGNED NULL AFTER from_deal_id,
    DROP CONSTRAINT chk_stock_reservation_events_type,
    ADD CONSTRAINT chk_stock_reservation_events_type CHECK (event_type IN ('created', 'consumed', 'released', 'expired', 'cancelled', 'shortfall', 'status_changed', 'pending_reconcile', 'superseded', 'deal_linked', 'deal_unlinked', 'deal_relinked')),
    ADD CONSTRAINT chk_stock_reservation_events_deal_link CHECK ((event_type = 'deal_linked' AND from_deal_id IS NULL AND to_deal_id IS NOT NULL) OR (event_type = 'deal_unlinked' AND from_deal_id IS NOT NULL AND to_deal_id IS NULL) OR (event_type = 'deal_relinked' AND from_deal_id IS NOT NULL AND to_deal_id IS NOT NULL AND from_deal_id <> to_deal_id) OR (event_type NOT IN ('deal_linked', 'deal_unlinked', 'deal_relinked') AND from_deal_id IS NULL AND to_deal_id IS NULL));
