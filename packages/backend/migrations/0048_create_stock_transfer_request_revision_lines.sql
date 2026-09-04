CREATE TABLE IF NOT EXISTS stock_transfer_request_revision_lines (
    revision_id BIGINT UNSIGNED NOT NULL,
    line_kind VARCHAR(16) CHARACTER SET ascii NOT NULL,
    line_ordinal INT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NULL,
    product_name VARCHAR(500) NOT NULL,
    quantity DECIMAL(21, 9) NOT NULL,
    product_link VARCHAR(500) NOT NULL,
    line_note VARCHAR(500) NOT NULL,
    PRIMARY KEY (revision_id, line_kind, line_ordinal),
    KEY ix_stock_transfer_request_lines_product (product_id, revision_id),
    CONSTRAINT fk_stock_transfer_request_lines_revision FOREIGN KEY (revision_id) REFERENCES stock_transfer_request_revisions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfer_request_lines_kind CHECK (line_kind IN ('transfer', 'supply')),
    CONSTRAINT chk_stock_transfer_request_lines_ordinal CHECK (line_ordinal > 0),
    CONSTRAINT chk_stock_transfer_request_lines_quantity CHECK (quantity > 0),
    CONSTRAINT chk_stock_transfer_request_lines_identity CHECK ((line_kind = 'transfer' AND product_id IS NOT NULL AND product_id > 0) OR (line_kind = 'supply' AND ((product_id IS NOT NULL AND product_id > 0) OR CHAR_LENGTH(product_name) > 0)))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
