CREATE TABLE IF NOT EXISTS stock_reservation_request_lines (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    request_id BIGINT UNSIGNED NOT NULL,
    source_line_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    erp_warehouse_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    item_code VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    requested_qty DECIMAL(21, 9) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_stock_reservation_request_lines_source (request_id, source_line_key, erp_warehouse_name, item_code),
    KEY ix_stock_reservation_request_lines_item (erp_warehouse_name, item_code),
    CONSTRAINT fk_stock_reservation_request_lines_request FOREIGN KEY (request_id) REFERENCES stock_reservation_requests (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_reservation_request_lines_identity CHECK (CHAR_LENGTH(source_line_key) > 0 AND CHAR_LENGTH(erp_warehouse_name) > 0 AND CHAR_LENGTH(item_code) > 0),
    CONSTRAINT chk_stock_reservation_request_lines_qty CHECK (requested_qty > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
