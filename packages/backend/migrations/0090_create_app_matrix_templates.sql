CREATE TABLE app_matrix_templates (
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  node_no INT UNSIGNED NOT NULL,
  parent_no INT UNSIGNED NOT NULL,
  ordinal_no INT UNSIGNED NOT NULL,
  f_id LONGTEXT NOT NULL,
  f_name LONGTEXT NOT NULL,
  f_from LONGTEXT NOT NULL,
  f_to LONGTEXT NOT NULL,
  f_sales_scope LONGTEXT NOT NULL,
  f_created_at LONGTEXT NOT NULL,
  f_updated_at LONGTEXT NOT NULL,
  PRIMARY KEY (snapshot_id,node_no),
  UNIQUE KEY ordered_child (snapshot_id,parent_no,ordinal_no),
  FOREIGN KEY (snapshot_id) REFERENCES app_state_revisions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
