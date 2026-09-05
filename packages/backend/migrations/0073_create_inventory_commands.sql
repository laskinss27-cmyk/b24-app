CREATE TABLE IF NOT EXISTS inventory_commands (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    command_kind VARCHAR(16) CHARACTER SET ascii NOT NULL,
    request_hash BINARY(32) NOT NULL,
    inventory_id BIGINT UNSIGNED NULL,
    mutation_id BIGINT UNSIGNED NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    completed_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_inventory_commands_key (idempotency_key),
    KEY ix_inventory_commands_inventory (inventory_id, id),
    CONSTRAINT fk_inventory_commands_record FOREIGN KEY (inventory_id) REFERENCES inventory_records (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_commands_mutation FOREIGN KEY (mutation_id) REFERENCES inventory_mutations (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_commands_kind CHECK (command_kind IN ('create', 'update', 'delete')),
    CONSTRAINT chk_inventory_commands_result CHECK ((inventory_id IS NULL AND mutation_id IS NULL AND completed_at IS NULL) OR (inventory_id IS NOT NULL AND mutation_id IS NOT NULL AND completed_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
