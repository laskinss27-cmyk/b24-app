ALTER TABLE inventory_result_lines
    ADD COLUMN retail_price DECIMAL(21, 9) NULL AFTER line_comment,
    ADD CONSTRAINT chk_inventory_result_retail_price CHECK (retail_price IS NULL OR retail_price >= 0);
