CREATE TABLE IF NOT EXISTS stock_transfer_history_changes (
    revision_id BIGINT UNSIGNED NOT NULL,
    event_ordinal INT UNSIGNED NOT NULL,
    change_ordinal INT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_name VARCHAR(500) NOT NULL,
    field_name VARCHAR(24) CHARACTER SET ascii NOT NULL,
    from_value VARCHAR(500) NOT NULL,
    to_value VARCHAR(500) NOT NULL,
    PRIMARY KEY (revision_id, event_ordinal, change_ordinal),
    KEY ix_stock_transfer_history_changes_product (product_id, field_name),
    CONSTRAINT fk_stock_transfer_history_changes_event FOREIGN KEY (revision_id, event_ordinal) REFERENCES stock_transfer_revision_history (revision_id, event_ordinal) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfer_history_changes_ordinal CHECK (change_ordinal > 0),
    CONSTRAINT chk_stock_transfer_history_changes_field CHECK (field_name IN ('planned', 'collected', 'accepted', 'destination'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
