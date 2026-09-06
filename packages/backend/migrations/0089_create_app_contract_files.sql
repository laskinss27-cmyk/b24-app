CREATE TABLE app_contract_files (
 document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 deal_id BIGINT UNSIGNED NOT NULL,
 file_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 byte_length BIGINT UNSIGNED NOT NULL,
	staging_name VARCHAR(160) CHARACTER SET ascii NOT NULL DEFAULT '',
 status ENUM('pending','ready') NOT NULL,
 CHECK(deal_id > 0 AND byte_length > 0)
) ENGINE=InnoDB;
