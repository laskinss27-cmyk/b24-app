CREATE TABLE IF NOT EXISTS stock_reservation_backfill_checkpoints (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    plan_hash BINARY(32) NOT NULL,
    observed_at DATETIME(6) NOT NULL,
    bitrix_transfer_records INT UNSIGNED NOT NULL,
    bitrix_basket_reservation_records INT UNSIGNED NOT NULL,
    erp_bin_records INT UNSIGNED NOT NULL,
    reservation_count INT UNSIGNED NOT NULL,
    line_count INT UNSIGNED NOT NULL,
    shortfall_line_count INT UNSIGNED NOT NULL,
    warning_count INT UNSIGNED NOT NULL,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_stock_reservation_backfill_checkpoints_hash (plan_hash),
    KEY ix_stock_reservation_backfill_checkpoints_applied (applied_at),
    CONSTRAINT chk_stock_reservation_backfill_sources CHECK (bitrix_transfer_records >= 0 AND bitrix_basket_reservation_records >= 0 AND erp_bin_records >= 0),
    CONSTRAINT chk_stock_reservation_backfill_rows CHECK (reservation_count >= 0 AND line_count >= 0 AND shortfall_line_count >= 0 AND warning_count >= 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
