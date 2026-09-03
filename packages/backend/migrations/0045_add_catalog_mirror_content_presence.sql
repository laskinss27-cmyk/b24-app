ALTER TABLE catalog_mirror_products
    ADD COLUMN content_present TINYINT(1) NOT NULL DEFAULT 0 AFTER content_summary,
    ADD CONSTRAINT chk_catalog_mirror_products_content_present CHECK (content_present IN (0, 1));
