CREATE TABLE app_realization_stores (
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  node_no INT UNSIGNED NOT NULL,
  parent_no INT UNSIGNED NOT NULL,
  ordinal_no INT UNSIGNED NOT NULL,
  entry_key VARCHAR(200) COLLATE utf8mb4_bin NOT NULL,
  f_store_id DOUBLE NOT NULL,
  f_store_name LONGTEXT NOT NULL,
  PRIMARY KEY (snapshot_id,node_no),
  UNIQUE KEY ordered_child (snapshot_id,parent_no,ordinal_no),
  FOREIGN KEY (snapshot_id) REFERENCES app_state_revisions(id),
  FOREIGN KEY (snapshot_id,parent_no) REFERENCES app_legacy_realizations(snapshot_id,node_no),
  UNIQUE KEY mapped_child (snapshot_id,parent_no,entry_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
