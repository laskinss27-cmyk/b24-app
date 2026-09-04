CREATE TABLE IF NOT EXISTS stock_transfer_request_records (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    bitrix_external_id BIGINT UNSIGNED NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    last_state_hash BINARY(32) NULL,
    deleted_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_stock_transfer_request_records_bitrix (bitrix_external_id),
    KEY ix_stock_transfer_request_records_deleted (deleted_at),
    CONSTRAINT chk_stock_transfer_request_records_external CHECK (bitrix_external_id > 0),
    CONSTRAINT chk_stock_transfer_request_records_name CHECK (CHAR_LENGTH(display_name) > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
