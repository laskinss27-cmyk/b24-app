CREATE TABLE IF NOT EXISTS repair_backfill_checkpoints (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    observed_at DATETIME(6) NOT NULL,
    source_record_count INT UNSIGNED NOT NULL,
    normalized_record_count INT UNSIGNED NOT NULL,
    history_row_count INT UNSIGNED NOT NULL,
    media_row_count INT UNSIGNED NOT NULL,
    plan_hash BINARY(32) NOT NULL,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_repair_backfill_hash (plan_hash),
    KEY ix_repair_backfill_observed (observed_at, id),
    CONSTRAINT chk_repair_backfill_counts CHECK (source_record_count = normalized_record_count)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
