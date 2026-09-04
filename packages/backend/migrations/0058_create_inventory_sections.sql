CREATE TABLE IF NOT EXISTS inventory_sections (
    inventory_id BIGINT UNSIGNED NOT NULL,
    section_id BIGINT UNSIGNED NOT NULL,
    section_ordinal INT UNSIGNED NOT NULL,
    is_present TINYINT(1) NOT NULL DEFAULT 1,
    PRIMARY KEY (inventory_id, section_id),
    KEY ix_inventory_sections_order (inventory_id, is_present, section_ordinal),
    CONSTRAINT fk_inventory_sections_record FOREIGN KEY (inventory_id) REFERENCES inventory_records (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_sections_ordinal CHECK (section_ordinal > 0),
    CONSTRAINT chk_inventory_sections_id CHECK (section_id > 0),
    CONSTRAINT chk_inventory_sections_present CHECK (is_present IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
