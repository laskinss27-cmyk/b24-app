CREATE TABLE IF NOT EXISTS catalog_mirror_stocks (
    item_code BIGINT UNSIGNED NOT NULL,
    warehouse_name VARCHAR(191) NOT NULL,
    actual_qty DECIMAL(24, 9) NOT NULL,
    source_modified_at DATETIME(6) NULL,
    observed_at DATETIME(6) NOT NULL,
    source_hash BINARY(32) NOT NULL,
    PRIMARY KEY (item_code, warehouse_name),
    KEY ix_catalog_mirror_stocks_warehouse (warehouse_name, item_code),
    KEY ix_catalog_mirror_stocks_observed (observed_at),
    CONSTRAINT fk_catalog_mirror_stocks_product FOREIGN KEY (item_code) REFERENCES catalog_mirror_products (item_code) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_catalog_mirror_stocks_warehouse FOREIGN KEY (warehouse_name) REFERENCES catalog_mirror_warehouses (warehouse_name) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
