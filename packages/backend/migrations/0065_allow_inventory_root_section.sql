ALTER TABLE inventory_sections
    DROP CONSTRAINT chk_inventory_sections_id,
    ADD CONSTRAINT chk_inventory_sections_id CHECK (section_id >= 0);
