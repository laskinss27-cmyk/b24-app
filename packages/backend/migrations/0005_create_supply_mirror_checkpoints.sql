CREATE TABLE IF NOT EXISTS supply_mirror_checkpoints (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    plan_hash BINARY(32) NOT NULL,
    observed_at DATETIME(6) NOT NULL,
    erpnext_records INT UNSIGNED NOT NULL,
    bitrix_transfer_records INT UNSIGNED NOT NULL,
    bitrix_transfer_request_records INT UNSIGNED NOT NULL,
    document_count INT UNSIGNED NOT NULL,
    line_count INT UNSIGNED NOT NULL,
    link_count INT UNSIGNED NOT NULL,
    allocation_count INT UNSIGNED NOT NULL,
    warning_count INT UNSIGNED NOT NULL,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_supply_mirror_checkpoints_hash (plan_hash),
    KEY ix_supply_mirror_checkpoints_applied (applied_at),
    CONSTRAINT chk_supply_mirror_checkpoints_sources CHECK (erpnext_records >= 0 AND bitrix_transfer_records >= 0 AND bitrix_transfer_request_records >= 0),
    CONSTRAINT chk_supply_mirror_checkpoints_rows CHECK (document_count >= 0 AND line_count >= 0 AND link_count >= 0 AND allocation_count >= 0 AND warning_count >= 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
