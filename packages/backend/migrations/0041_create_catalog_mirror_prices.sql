CREATE TABLE IF NOT EXISTS catalog_mirror_prices (
    item_code BIGINT UNSIGNED NOT NULL,
    price_kind VARCHAR(16) CHARACTER SET ascii NOT NULL,
    price_list VARCHAR(120) NOT NULL,
    source_system VARCHAR(16) CHARACTER SET ascii NOT NULL,
    currency CHAR(3) CHARACTER SET ascii NOT NULL,
    rate DECIMAL(24, 9) NOT NULL,
    source_modified_at DATETIME(6) NULL,
    observed_at DATETIME(6) NOT NULL,
    source_hash BINARY(32) NOT NULL,
    PRIMARY KEY (item_code, price_kind),
    KEY ix_catalog_mirror_prices_observed (observed_at),
    CONSTRAINT fk_catalog_mirror_prices_product FOREIGN KEY (item_code) REFERENCES catalog_mirror_products (item_code) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_catalog_mirror_prices_kind CHECK (price_kind IN ('retail', 'purchase')),
    CONSTRAINT chk_catalog_mirror_prices_source CHECK (source_system IN ('erpnext', 'bitrix')),
    CONSTRAINT chk_catalog_mirror_prices_currency CHECK (CHAR_LENGTH(currency) = 3),
    CONSTRAINT chk_catalog_mirror_prices_rate CHECK (rate >= 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
