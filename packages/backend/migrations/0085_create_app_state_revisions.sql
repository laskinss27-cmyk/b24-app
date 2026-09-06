CREATE TABLE app_state_revisions (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 module_name VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 owner_key VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 content_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 KEY collection_revisions(module_name,owner_key),
 FOREIGN KEY(module_name,owner_key) REFERENCES app_state_heads(module_name,owner_key)
) ENGINE=InnoDB;
