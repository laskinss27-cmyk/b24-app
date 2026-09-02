CREATE TABLE IF NOT EXISTS stock_transfer_revision_corrections (
    revision_id BIGINT UNSIGNED NOT NULL,
    correction_ordinal INT UNSIGNED NOT NULL,
    correction_external_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (revision_id, correction_ordinal),
    KEY ix_stock_transfer_revision_corrections_external (correction_external_id),
    CONSTRAINT fk_stock_transfer_revision_corrections_revision FOREIGN KEY (revision_id) REFERENCES stock_transfer_revisions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfer_revision_corrections_ordinal CHECK (correction_ordinal > 0),
    CONSTRAINT chk_stock_transfer_revision_corrections_external CHECK (correction_external_id > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
