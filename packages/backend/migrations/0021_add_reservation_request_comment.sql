ALTER TABLE stock_reservation_requests
    ADD COLUMN request_comment VARCHAR(1000) NULL AFTER requested_expires_at;
