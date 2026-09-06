CREATE TABLE IF NOT EXISTS repair_media (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    repair_id BIGINT UNSIGNED NOT NULL,
    media_kind VARCHAR(16) CHARACTER SET ascii NOT NULL,
    ordinal INT UNSIGNED NOT NULL,
    bitrix_file_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    display_name VARCHAR(500) NOT NULL DEFAULT '',
    media_url TEXT NOT NULL,
    media_type VARCHAR(191) NOT NULL DEFAULT '',
    is_present BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (id),
    UNIQUE KEY uq_repair_media_ordinal (repair_id, media_kind, ordinal),
    KEY ix_repair_media_record (repair_id, id),
    CONSTRAINT fk_repair_media_record FOREIGN KEY (repair_id) REFERENCES repair_records (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_repair_media_kind CHECK (media_kind IN ('photo', 'file')),
    CONSTRAINT chk_repair_media_url CHECK (CHAR_LENGTH(media_url) > 0),
    CONSTRAINT chk_repair_media_present CHECK (is_present IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
