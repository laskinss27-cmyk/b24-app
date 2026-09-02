ALTER TABLE stock_transfer_history_changes
    ADD COLUMN from_value_type VARCHAR(12) CHARACTER SET ascii NOT NULL DEFAULT 'string' AFTER from_value,
    ADD COLUMN to_value_type VARCHAR(12) CHARACTER SET ascii NOT NULL DEFAULT 'string' AFTER to_value,
    ADD CONSTRAINT chk_stock_transfer_change_from_type CHECK (from_value_type IN ('number', 'string')),
    ADD CONSTRAINT chk_stock_transfer_change_to_type CHECK (to_value_type IN ('number', 'string'));
