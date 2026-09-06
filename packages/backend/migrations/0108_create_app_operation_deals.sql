CREATE TABLE app_operation_deals (
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  node_no INT UNSIGNED NOT NULL,
  parent_no INT UNSIGNED NOT NULL,
  ordinal_no INT UNSIGNED NOT NULL,
  f_id DOUBLE NOT NULL,
  f_title LONGTEXT NULL,
  PRIMARY KEY (snapshot_id,node_no),
  UNIQUE KEY ordered_child (snapshot_id,parent_no,ordinal_no),
  FOREIGN KEY (snapshot_id) REFERENCES app_state_revisions(id),
  FOREIGN KEY (snapshot_id,parent_no) REFERENCES app_operation_events(snapshot_id,node_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
