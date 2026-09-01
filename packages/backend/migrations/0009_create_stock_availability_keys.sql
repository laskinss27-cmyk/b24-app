CREATE TABLE IF NOT EXISTS stock_availability_keys (
    erp_warehouse_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    item_code VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (erp_warehouse_name, item_code),
    CONSTRAINT chk_stock_availability_keys_warehouse CHECK (CHAR_LENGTH(erp_warehouse_name) > 0),
    CONSTRAINT chk_stock_availability_keys_item CHECK (CHAR_LENGTH(item_code) > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
