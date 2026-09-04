CREATE TABLE IF NOT EXISTS inventory_result_lines (
    point_id BIGINT UNSIGNED NOT NULL,
    line_ordinal INT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_name VARCHAR(500) NOT NULL,
    book_qty DECIMAL(21, 9) NOT NULL,
    fact_qty DECIMAL(21, 9) NOT NULL,
    difference_qty DECIMAL(21, 9) NOT NULL,
    line_comment VARCHAR(500) NOT NULL,
    is_present TINYINT(1) NOT NULL DEFAULT 1,
    PRIMARY KEY (point_id, product_id),
    KEY ix_inventory_result_lines_order (point_id, is_present, line_ordinal),
    KEY ix_inventory_result_lines_product (product_id, point_id),
    CONSTRAINT fk_inventory_result_lines_point FOREIGN KEY (point_id) REFERENCES inventory_points (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_result_ordinal CHECK (line_ordinal > 0),
    CONSTRAINT chk_inventory_result_product CHECK (product_id > 0),
    CONSTRAINT chk_inventory_result_present CHECK (is_present IN (0, 1)),
    CONSTRAINT chk_inventory_result_quantities CHECK (book_qty >= 0 AND fact_qty >= 0 AND ABS((fact_qty - book_qty) - difference_qty) < 0.000000001 AND ABS(difference_qty) >= 0.000000001)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
