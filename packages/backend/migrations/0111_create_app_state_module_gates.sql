CREATE TABLE app_state_module_gates (
 module_name VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 plan_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 FOREIGN KEY(plan_hash) REFERENCES app_state_checkpoints(plan_hash)
) ENGINE=InnoDB;
