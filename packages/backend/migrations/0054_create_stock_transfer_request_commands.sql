CREATE TABLE IF NOT EXISTS stock_transfer_request_commands (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    command_kind VARCHAR(16) CHARACTER SET ascii NOT NULL,
    request_hash BINARY(32) NOT NULL,
    request_id BIGINT UNSIGNED NULL,
    revision_id BIGINT UNSIGNED NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    completed_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_stock_transfer_request_commands_key (idempotency_key),
    KEY ix_stock_transfer_request_commands_request (request_id, id),
    CONSTRAINT fk_stock_transfer_request_commands_record FOREIGN KEY (request_id) REFERENCES stock_transfer_request_records (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfer_request_commands_revision FOREIGN KEY (revision_id) REFERENCES stock_transfer_request_revisions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfer_request_commands_kind CHECK (command_kind IN ('create', 'update', 'delete')),
    CONSTRAINT chk_stock_transfer_request_commands_result CHECK ((request_id IS NULL AND revision_id IS NULL AND completed_at IS NULL) OR (request_id IS NOT NULL AND revision_id IS NOT NULL AND completed_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
