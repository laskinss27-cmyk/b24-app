CREATE TABLE IF NOT EXISTS supply_transfer_payloads (
    document_id BIGINT UNSIGNED NOT NULL,
    external_id BIGINT UNSIGNED NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    observed_at DATETIME(6) NOT NULL,
    source_hash BINARY(32) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (document_id),
    UNIQUE KEY uq_supply_transfer_payloads_external (external_id),
    KEY ix_supply_transfer_payloads_observed_at (observed_at),
    CONSTRAINT fk_supply_transfer_payloads_document FOREIGN KEY (document_id) REFERENCES workflow_documents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_supply_transfer_payloads_external CHECK (external_id > 0),
    CONSTRAINT chk_supply_transfer_payloads_name CHECK (CHAR_LENGTH(display_name) > 0),
    CONSTRAINT chk_supply_transfer_payloads_json CHECK (JSON_VALID(payload) AND JSON_TYPE(payload) = 'OBJECT')
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
