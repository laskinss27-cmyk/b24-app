CREATE TABLE IF NOT EXISTS repair_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    repair_id BIGINT UNSIGNED NOT NULL,
    ordinal INT UNSIGNED NOT NULL,
    happened_at DATETIME(6) NULL,
    repair_status VARCHAR(32) CHARACTER SET ascii NOT NULL,
    actor_id VARCHAR(191) NOT NULL DEFAULT '',
    actor_name VARCHAR(255) NOT NULL DEFAULT '',
    note TEXT NULL,
    is_present BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (id),
    UNIQUE KEY uq_repair_history_ordinal (repair_id, ordinal),
    KEY ix_repair_history_time (repair_id, happened_at, ordinal),
    CONSTRAINT fk_repair_history_record FOREIGN KEY (repair_id) REFERENCES repair_records (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_repair_history_status CHECK (repair_status IN ('received_tt', 'received_office', 'sent', 'sent_to_tt', 'ready_tt', 'issued', 'pre_office', 'pre_sent', 'pre_back_office', 'pre_to_point', 'pre_at_tt')),
    CONSTRAINT chk_repair_history_present CHECK (is_present IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
