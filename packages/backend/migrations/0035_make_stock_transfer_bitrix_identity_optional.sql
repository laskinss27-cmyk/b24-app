ALTER TABLE stock_transfer_records
    DROP CONSTRAINT chk_stock_transfer_records_external,
    MODIFY COLUMN bitrix_external_id BIGINT UNSIGNED NULL,
    ADD CONSTRAINT chk_stock_transfer_records_external CHECK (bitrix_external_id IS NULL OR bitrix_external_id > 0);
