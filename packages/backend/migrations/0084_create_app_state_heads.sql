CREATE TABLE app_state_heads (
 module_name VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 owner_key VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 mirror_revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 PRIMARY KEY(module_name,owner_key)
) ENGINE=InnoDB;
