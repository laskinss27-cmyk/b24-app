CREATE TABLE IF NOT EXISTS inventory_public_ids (
    public_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    legacy_bitrix_external_id BIGINT UNSIGNED NULL,
    allocated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (public_id),
    UNIQUE KEY uq_inventory_public_ids_legacy (legacy_bitrix_external_id),
    CONSTRAINT chk_inventory_public_ids_legacy CHECK (legacy_bitrix_external_id IS NULL OR legacy_bitrix_external_id > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
