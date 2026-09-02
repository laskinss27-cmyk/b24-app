CREATE TABLE IF NOT EXISTS stock_transfer_revision_lines (
    revision_id BIGINT UNSIGNED NOT NULL,
    phase VARCHAR(24) CHARACTER SET ascii NOT NULL,
    line_ordinal INT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_name VARCHAR(500) NOT NULL,
    quantity DECIMAL(21, 9) NOT NULL,
    PRIMARY KEY (revision_id, phase, line_ordinal),
    KEY ix_stock_transfer_revision_lines_product (product_id, phase),
    CONSTRAINT fk_stock_transfer_revision_lines_revision FOREIGN KEY (revision_id) REFERENCES stock_transfer_revisions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfer_revision_lines_phase CHECK (phase IN ('planned', 'collected', 'shipped', 'accepted', 'received', 'shortage')),
    CONSTRAINT chk_stock_transfer_revision_lines_ordinal CHECK (line_ordinal > 0),
    CONSTRAINT chk_stock_transfer_revision_lines_product CHECK (product_id > 0),
    CONSTRAINT chk_stock_transfer_revision_lines_qty CHECK (quantity >= 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
