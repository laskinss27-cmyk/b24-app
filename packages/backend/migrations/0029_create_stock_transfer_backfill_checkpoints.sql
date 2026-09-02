CREATE TABLE IF NOT EXISTS stock_transfer_backfill_checkpoints (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    plan_hash BINARY(32) NOT NULL,
    observed_at DATETIME(6) NOT NULL,
    source_record_count INT UNSIGNED NOT NULL,
    created_revision_count INT UNSIGNED NOT NULL,
    unchanged_record_count INT UNSIGNED NOT NULL,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_stock_transfer_backfill_hash (plan_hash),
    KEY ix_stock_transfer_backfill_applied (applied_at),
    CONSTRAINT chk_stock_transfer_backfill_counts CHECK (
        created_revision_count + unchanged_record_count = source_record_count
    )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
