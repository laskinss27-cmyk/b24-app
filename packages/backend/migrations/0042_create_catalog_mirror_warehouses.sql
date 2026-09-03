CREATE TABLE IF NOT EXISTS catalog_mirror_warehouses (
    warehouse_name VARCHAR(191) NOT NULL,
    display_title VARCHAR(255) NOT NULL,
    warehouse_type VARCHAR(120) NOT NULL,
    active TINYINT(1) NOT NULL,
    source_modified_at DATETIME(6) NULL,
    observed_at DATETIME(6) NOT NULL,
    source_hash BINARY(32) NOT NULL,
    PRIMARY KEY (warehouse_name),
    KEY ix_catalog_mirror_warehouses_title (display_title),
    KEY ix_catalog_mirror_warehouses_observed (observed_at),
    CONSTRAINT chk_catalog_mirror_warehouses_name CHECK (CHAR_LENGTH(warehouse_name) > 0),
    CONSTRAINT chk_catalog_mirror_warehouses_title CHECK (CHAR_LENGTH(display_title) > 0),
    CONSTRAINT chk_catalog_mirror_warehouses_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
