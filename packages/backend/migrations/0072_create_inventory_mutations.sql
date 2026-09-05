CREATE TABLE IF NOT EXISTS inventory_mutations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    inventory_id BIGINT UNSIGNED NOT NULL,
    mutation_no INT UNSIGNED NOT NULL,
    operation_kind VARCHAR(16) CHARACTER SET ascii NOT NULL,
    state_hash BINARY(32) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_inventory_mutations_number (inventory_id, mutation_no),
    KEY ix_inventory_mutations_inventory (inventory_id, id),
    CONSTRAINT fk_inventory_mutations_record FOREIGN KEY (inventory_id) REFERENCES inventory_records (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_mutations_operation CHECK (operation_kind IN ('upsert', 'delete'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
