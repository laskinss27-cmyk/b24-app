CREATE TABLE app_log_identities (
 event_id VARCHAR(160) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
 revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 content_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 append_no BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 UNIQUE KEY append_order(append_no),
 UNIQUE KEY event_revision(revision_id),
 FOREIGN KEY(revision_id) REFERENCES app_state_revisions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
