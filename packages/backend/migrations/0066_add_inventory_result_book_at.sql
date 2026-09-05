ALTER TABLE inventory_points
    ADD COLUMN result_book_at DATETIME(6) NULL AFTER result_discrepancies;
