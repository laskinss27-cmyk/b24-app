CREATE TABLE app_operation_details (
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  node_no INT UNSIGNED NOT NULL,
  parent_no INT UNSIGNED NOT NULL,
  ordinal_no INT UNSIGNED NOT NULL,
  entry_key VARCHAR(200) COLLATE utf8mb4_bin NOT NULL,
  scalar_value_kind ENUM('text','number','boolean') NOT NULL,
  scalar_value_text LONGTEXT NULL,
  scalar_value_number DOUBLE NULL,
  scalar_value_boolean BOOLEAN NULL,
  CHECK ((scalar_value_kind='text' AND scalar_value_text IS NOT NULL AND scalar_value_number IS NULL AND scalar_value_boolean IS NULL) OR (scalar_value_kind='number' AND scalar_value_text IS NULL AND scalar_value_number IS NOT NULL AND scalar_value_boolean IS NULL) OR (scalar_value_kind='boolean' AND scalar_value_text IS NULL AND scalar_value_number IS NULL AND scalar_value_boolean IN (0,1))),
  PRIMARY KEY (snapshot_id,node_no),
  UNIQUE KEY ordered_child (snapshot_id,parent_no,ordinal_no),
  FOREIGN KEY (snapshot_id) REFERENCES app_state_revisions(id),
  FOREIGN KEY (snapshot_id,parent_no) REFERENCES app_operation_events(snapshot_id,node_no),
  UNIQUE KEY mapped_child (snapshot_id,parent_no,entry_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
