CREATE TABLE app_contract_commands (
 idempotency_key VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 contract_number VARCHAR(80) NOT NULL,
 created_at_iso VARCHAR(40) CHARACTER SET ascii NOT NULL,
 UNIQUE KEY contract_identity(document_id)
) ENGINE=InnoDB;
