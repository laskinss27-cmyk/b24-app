CREATE TABLE IF NOT EXISTS repair_identities (
    public_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    repair_no BIGINT UNSIGNED NOT NULL,
    bitrix_external_id BIGINT UNSIGNED NULL,
    idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
    request_hash BINARY(32) NULL,
    allocated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    consumed_at DATETIME(6) NULL,
    PRIMARY KEY (public_id),
    UNIQUE KEY uq_repair_identities_number (repair_no),
    UNIQUE KEY uq_repair_identities_bitrix (bitrix_external_id),
    UNIQUE KEY uq_repair_identities_command (idempotency_key),
    CONSTRAINT chk_repair_identities_number CHECK (repair_no > 0),
    CONSTRAINT chk_repair_identities_request CHECK ((idempotency_key IS NULL AND request_hash IS NULL) OR (idempotency_key IS NOT NULL AND request_hash IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
