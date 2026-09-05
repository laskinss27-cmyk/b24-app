ALTER TABLE inventory_points
    DROP CONSTRAINT chk_inventory_points_result,
    ADD CONSTRAINT chk_inventory_points_result CHECK ((result_total IS NULL AND result_counted IS NULL AND result_discrepancies IS NULL) OR (result_total IS NOT NULL AND result_counted IS NOT NULL AND result_discrepancies IS NOT NULL AND result_counted <= result_total AND result_discrepancies <= result_total));
