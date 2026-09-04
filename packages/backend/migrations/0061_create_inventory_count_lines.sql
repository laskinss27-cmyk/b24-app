CREATE TABLE IF NOT EXISTS inventory_count_lines (
    point_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    fact_qty DECIMAL(21, 9) NULL,
    line_comment VARCHAR(500) NOT NULL,
    is_present TINYINT(1) NOT NULL DEFAULT 1,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (point_id, product_id),
    KEY ix_inventory_count_lines_product (product_id, point_id),
    CONSTRAINT fk_inventory_count_lines_point FOREIGN KEY (point_id) REFERENCES inventory_points (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_count_product CHECK (product_id > 0),
    CONSTRAINT chk_inventory_count_quantity CHECK (fact_qty IS NULL OR fact_qty >= 0),
    CONSTRAINT chk_inventory_count_present CHECK (is_present IN (0, 1)),
    CONSTRAINT chk_inventory_count_value CHECK (is_present = 0 OR fact_qty IS NOT NULL OR CHAR_LENGTH(line_comment) > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
