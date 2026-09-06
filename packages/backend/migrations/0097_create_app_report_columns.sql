CREATE TABLE app_report_columns (
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  node_no INT UNSIGNED NOT NULL,
  parent_no INT UNSIGNED NOT NULL,
  ordinal_no INT UNSIGNED NOT NULL,
  scalar_value LONGTEXT NOT NULL,
  PRIMARY KEY (snapshot_id,node_no),
  UNIQUE KEY ordered_child (snapshot_id,parent_no,ordinal_no),
  FOREIGN KEY (snapshot_id) REFERENCES app_state_revisions(id),
  FOREIGN KEY (snapshot_id,parent_no) REFERENCES app_report_definitions(snapshot_id,node_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
