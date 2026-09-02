CREATE TABLE IF NOT EXISTS stock_transfer_revision_history (
    revision_id BIGINT UNSIGNED NOT NULL,
    event_ordinal INT UNSIGNED NOT NULL,
    event_at DATETIME(6) NULL,
    status VARCHAR(32) CHARACTER SET ascii NOT NULL,
    actor_id VARCHAR(191) NOT NULL,
    actor_name VARCHAR(255) NOT NULL,
    action_name VARCHAR(32) CHARACTER SET ascii NULL,
    note TEXT NOT NULL,
    PRIMARY KEY (revision_id, event_ordinal),
    KEY ix_stock_transfer_revision_history_actor (actor_id, event_at),
    CONSTRAINT fk_stock_transfer_revision_history_revision FOREIGN KEY (revision_id) REFERENCES stock_transfer_revisions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfer_revision_history_ordinal CHECK (event_ordinal > 0),
    CONSTRAINT chk_stock_transfer_revision_history_status CHECK (status IN ('draft', 'collected', 'in_transit', 'accepted', 'posted', 'canceled', 'requested', 'received', 'shortage')),
    CONSTRAINT chk_stock_transfer_revision_history_action CHECK (action_name IS NULL OR action_name IN ('created', 'lines_changed', 'destination_changed', 'collected', 'shipped', 'accepted', 'posted', 'canceled', 'notification_sent', 'notification_failed', 'legacy')),
    CONSTRAINT chk_stock_transfer_revision_history_note CHECK (CHAR_LENGTH(note) <= 10000)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
