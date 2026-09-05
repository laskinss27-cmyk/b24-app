ALTER TABLE inventory_records
    DROP CONSTRAINT chk_inventory_records_external,
    MODIFY COLUMN bitrix_external_id BIGINT UNSIGNED NULL,
    ADD CONSTRAINT chk_inventory_records_external CHECK (bitrix_external_id IS NULL OR bitrix_external_id > 0);
