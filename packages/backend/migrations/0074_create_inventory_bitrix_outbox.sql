CREATE TABLE IF NOT EXISTS inventory_bitrix_outbox (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    inventory_id BIGINT UNSIGNED NOT NULL,
    mutation_id BIGINT UNSIGNED NOT NULL,
    operation_kind VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'upsert',
    status VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'pending',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_attempt_at DATETIME(6) NULL,
    lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    locked_until DATETIME(6) NULL,
    completed_at DATETIME(6) NULL,
    last_error VARCHAR(1000) NOT NULL DEFAULT '',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_inventory_outbox_mutation (mutation_id, operation_kind),
    KEY ix_inventory_outbox_pending (status, available_at, id),
    KEY ix_inventory_outbox_inventory (inventory_id, id),
    CONSTRAINT fk_inventory_outbox_record FOREIGN KEY (inventory_id) REFERENCES inventory_records (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_outbox_mutation FOREIGN KEY (mutation_id) REFERENCES inventory_mutations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_outbox_operation CHECK (operation_kind IN ('upsert', 'delete')),
    CONSTRAINT chk_inventory_outbox_status CHECK (status IN ('pending', 'processing', 'delivered', 'superseded')),
    CONSTRAINT chk_inventory_outbox_attempts CHECK (attempt_count <= 1000000),
    CONSTRAINT chk_inventory_outbox_completion CHECK (
        (status = 'pending' AND lease_token IS NULL AND locked_until IS NULL AND completed_at IS NULL)
        OR (status = 'processing' AND lease_token IS NOT NULL AND locked_until IS NOT NULL AND completed_at IS NULL)
        OR (status IN ('delivered', 'superseded') AND lease_token IS NULL AND locked_until IS NULL AND completed_at IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
