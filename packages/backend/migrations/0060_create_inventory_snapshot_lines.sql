CREATE TABLE IF NOT EXISTS inventory_snapshot_lines (
    point_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    book_qty DECIMAL(21, 9) NOT NULL,
    PRIMARY KEY (point_id, product_id),
    KEY ix_inventory_snapshot_lines_product (product_id, point_id),
    CONSTRAINT fk_inventory_snapshot_lines_point FOREIGN KEY (point_id) REFERENCES inventory_points (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_snapshot_product CHECK (product_id > 0),
    CONSTRAINT chk_inventory_snapshot_quantity CHECK (book_qty >= 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
