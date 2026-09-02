ALTER TABLE stock_transfer_revisions
    ADD COLUMN state_format_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER source_kind,
    ADD CONSTRAINT chk_stock_transfer_revision_format CHECK (state_format_version IN (1, 2));
