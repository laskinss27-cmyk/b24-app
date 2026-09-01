ALTER TABLE stock_reservation_commands
    DROP CONSTRAINT chk_stock_reservation_commands_type,
    ADD CONSTRAINT chk_stock_reservation_commands_type CHECK (command_type IN ('request_reserve', 'approve_reserve', 'reject_reserve', 'create_manual_reserve', 'link_deal', 'unlink_deal', 'relink_deal', 'adjust_transfer', 'consume', 'request_release', 'approve_release', 'reject_release', 'expire', 'reconcile_shortfall', 'mark_pending_reconcile', 'supersede'));
