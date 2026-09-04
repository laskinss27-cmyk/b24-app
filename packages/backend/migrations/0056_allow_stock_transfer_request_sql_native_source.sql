ALTER TABLE stock_transfer_request_revisions
    DROP CONSTRAINT chk_stock_transfer_request_revisions_source,
    ADD CONSTRAINT chk_stock_transfer_request_revisions_source CHECK (source_kind IN ('bitrix_backfill', 'bitrix_dual_write', 'repair', 'sql_native'));
