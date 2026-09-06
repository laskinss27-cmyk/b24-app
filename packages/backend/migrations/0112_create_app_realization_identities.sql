CREATE TABLE app_realization_identities (
 shipment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
 bitrix_external_id BIGINT UNSIGNED NOT NULL,
 UNIQUE KEY external_identity(bitrix_external_id),
 CHECK(shipment_id > 0 AND bitrix_external_id > 0)
) ENGINE=InnoDB;
