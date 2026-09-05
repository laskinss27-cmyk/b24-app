ALTER TABLE inventory_records
    ADD COLUMN public_id BIGINT UNSIGNED NULL AFTER id,
    ADD UNIQUE KEY uq_inventory_records_public_id (public_id),
    ADD CONSTRAINT chk_inventory_records_public_id CHECK (public_id IS NULL OR public_id > 0);
