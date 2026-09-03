import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from './migrations.js';

const projectMigrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

test('migration files are ordered and checksummed', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'b24-app-migrations-'));
	try {
		await writeFile(join(directory, '0002_second.sql'), 'SELECT 2;\n');
		await writeFile(join(directory, '0001_first.sql'), 'SELECT 1;\n');
		const migrations = await readMigrationFiles(directory);
		assert.deepEqual(migrations.map((migration) => migration.filename), ['0001_first.sql', '0002_second.sql']);
		assert.match(migrations[0]!.checksum, /^[a-f0-9]{64}$/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('migration filenames have a stable version prefix', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'b24-app-migrations-'));
	try {
		await writeFile(join(directory, 'initial.sql'), 'SELECT 1;\n');
		await assert.rejects(() => readMigrationFiles(directory), /Invalid migration filename/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('application SQL migrations are ordered and use narrowly scoped DDL', async () => {
	const migrations = await readMigrationFiles(projectMigrationsDirectory);
	assert.deepEqual(migrations.map((migration) => migration.filename), [
		'0001_create_workflow_documents.sql',
		'0002_create_workflow_document_lines.sql',
		'0003_create_workflow_document_links.sql',
		'0004_create_workflow_line_allocations.sql',
		'0005_create_supply_mirror_checkpoints.sql',
		'0006_create_tilda_product_mappings.sql',
		'0007_create_tilda_stock_sync_runs.sql',
		'0008_make_line_ordinal_identity_conditional.sql',
		'0009_create_stock_availability_keys.sql',
		'0010_create_stock_reservation_requests.sql',
		'0011_create_stock_reservation_request_lines.sql',
		'0012_create_stock_reservations.sql',
		'0013_create_stock_reservation_lines.sql',
		'0014_create_stock_reservation_release_requests.sql',
		'0015_create_stock_reservation_commands.sql',
		'0016_create_stock_reservation_events.sql',
		'0017_create_stock_reservation_backfill_checkpoints.sql',
		'0018_add_reservation_deal_link.sql',
		'0019_add_reservation_deal_link_events.sql',
		'0020_add_reservation_manual_commands.sql',
		'0021_add_reservation_request_comment.sql',
		'0022_create_supply_transfer_payloads.sql',
		'0023_create_stock_transfer_records.sql',
		'0024_create_stock_transfer_revisions.sql',
		'0025_create_stock_transfer_revision_lines.sql',
		'0026_create_stock_transfer_revision_history.sql',
		'0027_create_stock_transfer_history_changes.sql',
		'0028_create_stock_transfer_revision_corrections.sql',
		'0029_create_stock_transfer_backfill_checkpoints.sql',
		'0030_add_stock_transfer_revision_format.sql',
		'0031_add_stock_transfer_change_value_types.sql',
		'0032_add_stock_transfer_public_id.sql',
		'0033_create_stock_transfer_public_ids.sql',
		'0034_create_stock_transfer_identity_checkpoints.sql',
		'0035_make_stock_transfer_bitrix_identity_optional.sql',
		'0036_create_stock_transfer_commands.sql',
		'0037_create_stock_transfer_bitrix_outbox.sql',
	]);
	for (const migration of migrations.filter((_, index) => index !== 7 && index < 17)) {
		assert.match(migration.sql, /^CREATE TABLE IF NOT EXISTS (?:workflow_|supply_mirror_|tilda_|stock_)[a-z_]+ \(/);
		assert.equal(migration.sql.split(';').filter((statement) => statement.trim()).length, 1);
		assert.doesNotMatch(migration.sql, /^\s*(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/im);
		assert.doesNotMatch(migration.sql, /\bJSON\b/i);
		assert.match(migration.sql, /ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\s*$/);
		const identifiers = [...migration.sql.matchAll(/(?:CONSTRAINT|UNIQUE KEY|KEY)\s+([a-z0-9_]+)/g)].map((match) => match[1]!);
		assert.ok(identifiers.every((identifier) => identifier.length <= 64));
	}

	const lineIdentityMigration = migrations[7]!.sql;
	assert.equal(lineIdentityMigration.split(';').filter((statement) => statement.trim()).length, 1);
	assert.match(lineIdentityMigration, /^ALTER TABLE workflow_document_lines\b/);
	assert.doesNotMatch(lineIdentityMigration, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/im);
	assert.doesNotMatch(lineIdentityMigration, /\bDROP\s+(?:TABLE|DATABASE|COLUMN)\b/i);
	assert.doesNotMatch(lineIdentityMigration, /\bJSON\b/i);
	assert.match(lineIdentityMigration, /DROP INDEX uq_workflow_document_lines_ordinal/);
	assert.match(lineIdentityMigration, /GENERATED ALWAYS AS \(CASE WHEN external_line_key IS NULL THEN line_ordinal ELSE NULL END\) STORED/);
	assert.match(lineIdentityMigration, /UNIQUE KEY uq_workflow_document_lines_fallback_ordinal \(document_id, identity_line_ordinal\)/);
	for (const migration of migrations.slice(17, 21)) {
		assert.equal(migration.sql.split(';').filter((statement) => statement.trim()).length, 1);
		assert.match(migration.sql, /^ALTER TABLE stock_/);
		assert.doesNotMatch(migration.sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP\s+(?:TABLE|DATABASE|COLUMN))\b/i);
	}
	const transferPayloads = migrations[21]!.sql;
	assert.match(transferPayloads, /^CREATE TABLE IF NOT EXISTS supply_transfer_payloads \(/);
	assert.equal(transferPayloads.split(';').filter((statement) => statement.trim()).length, 1);
	assert.doesNotMatch(transferPayloads, /^\s*(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/im);
	assert.match(transferPayloads, /FOREIGN KEY \(document_id\) REFERENCES workflow_documents \(id\).*ON DELETE RESTRICT/);
	assert.match(transferPayloads, /JSON_VALID\(payload\).*JSON_TYPE\(payload\) = 'OBJECT'/);
	assert.match(transferPayloads, /ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\s*$/);

	for (const migration of migrations.slice(22)) {
		assert.match(migration.sql, /^(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE) stock_transfer_[a-z_]+/);
		assert.equal(migration.sql.split(';').filter((statement) => statement.trim()).length, 1);
		assert.doesNotMatch(migration.sql, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|GRANT)\b/im);
		assert.doesNotMatch(migration.sql, /\bDROP\s+(?:TABLE|DATABASE|COLUMN)\b/i);
		assert.doesNotMatch(migration.sql, /\bJSON\b/i);
		if (migration.filename < '0030') {
			assert.match(migration.sql, /ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\s*$/);
		}
		const identifiers = [...migration.sql.matchAll(/(?:CONSTRAINT|UNIQUE KEY|KEY)\s+([a-z0-9_]+)/g)].map((match) => match[1]!);
		assert.ok(identifiers.every((identifier) => identifier.length <= 64));
	}
});

test('SQL schemas preserve workflow links and Tilda external identity', async () => {
	const migrations = await readMigrationFiles(projectMigrationsDirectory);
	const [documents, lines, links, allocations, checkpoints, tildaMappings, tildaRuns, lineIdentity] = migrations.map((migration) => migration.sql);

	assert.match(documents!, /UNIQUE KEY uq_workflow_documents_external \(external_system, document_type, external_id\)/);
	assert.match(documents!, /external_revision_key VARCHAR\(255\)/);
	assert.match(documents!, /KEY ix_workflow_documents_revision \(document_type, external_revision_key\)/);
	assert.match(documents!, /source_hash BINARY\(32\) NOT NULL/);
	assert.match(documents!, /document_type IN \('supply_request', 'purchase_order', 'purchase_receipt', 'transfer', 'stock_entry'\)/);
	assert.match(documents!, /external_status VARCHAR\(64\)/);

	assert.match(lines!, /UNIQUE KEY uq_workflow_document_lines_external \(document_id, external_line_key\)/);
	assert.match(lines!, /UNIQUE KEY uq_workflow_document_lines_ordinal \(document_id, line_ordinal\)/);
	assert.match(lines!, /erp_item_code VARCHAR\(191\)/);
	assert.match(lines!, /source_warehouse VARCHAR\(191\)/);
	assert.match(lines!, /target_warehouse VARCHAR\(191\)/);
	assert.doesNotMatch(lines!, /UNIQUE KEY[^\n]+erp_item_code/);
	assert.match(lines!, /planned_qty IS NOT NULL OR request_qty IS NOT NULL OR actual_qty IS NOT NULL/);
	assert.match(lineIdentity!, /CASE WHEN external_line_key IS NULL THEN line_ordinal ELSE NULL END/);
	assert.match(lineIdentity!, /UNIQUE KEY uq_workflow_document_lines_fallback_ordinal \(document_id, identity_line_ordinal\)/);

	assert.match(links!, /UNIQUE KEY uq_workflow_document_links_relation \(from_document_id, to_document_id, relation_type\)/);
	assert.match(links!, /relation_type IN \('ordered_for_request'.*'corrects_transfer'\)/);
	assert.match(links!, /evidence_kind IN \('explicit_external_field', 'native_erp_link', 'derived_match'\)/);
	assert.match(links!, /from_document_id <> to_document_id/);

	assert.match(allocations!, /UNIQUE KEY uq_workflow_line_allocations_relation \(source_line_id, target_line_id, allocation_type\)/);
	assert.match(allocations!, /allocation_type IN \('ordered', 'received', 'transferred', 'fulfilled', 'cancelled'\)/);
	assert.match(allocations!, /quantity > 0/);
	assert.match(allocations!, /source_line_id <> target_line_id/);

	assert.match(checkpoints!, /UNIQUE KEY uq_supply_mirror_checkpoints_hash \(plan_hash\)/);
	assert.match(checkpoints!, /plan_hash BINARY\(32\) NOT NULL/);
	assert.match(checkpoints!, /document_count INT UNSIGNED NOT NULL/);
	assert.doesNotMatch(checkpoints!, /\bJSON\b/i);

	assert.match(tildaMappings!, /UNIQUE KEY uq_tilda_product_mappings_uid \(tilda_uid\)/);
	assert.match(tildaMappings!, /UNIQUE KEY uq_tilda_product_mappings_external \(tilda_external_id\)/);
	assert.match(tildaMappings!, /tilda_sku VARCHAR\(120\) NULL/);
	assert.match(tildaMappings!, /erp_item_code VARCHAR\(191\) NULL/);
	assert.doesNotMatch(tildaMappings!, /UNIQUE KEY[^\n]+(?:tilda_sku|erp_item_code)/);
	assert.match(tildaMappings!, /mapping_status IN \('confirmed', 'unresolved', 'ignored'\)/);
	assert.match(tildaMappings!, /row_kind IN \('parent', 'variant'\)/);
	assert.match(tildaMappings!, /parent_tilda_uid VARCHAR\(64\) NULL/);
	assert.match(tildaMappings!, /variant_label VARCHAR\(255\) NULL/);
	assert.match(tildaMappings!, /audit_source VARCHAR\(191\) NOT NULL/);
	assert.match(tildaMappings!, /source_seen_at DATETIME\(6\) NOT NULL/);
	assert.match(tildaMappings!, /mapping_status <> 'confirmed' OR \(tilda_sku IS NOT NULL AND erp_item_code IS NOT NULL AND confirmed_at IS NOT NULL\)/);
	assert.doesNotMatch(tildaMappings!, /\bJSON\b/i);

	assert.match(tildaRuns!, /UNIQUE KEY uq_tilda_stock_sync_runs_uuid \(run_uuid\)/);
	assert.match(tildaRuns!, /projection_hash BINARY\(32\) NULL/);
	assert.match(tildaRuns!, /status IN \('running', 'no_op', 'verified', 'failed'\)/);
	assert.match(tildaRuns!, /trigger_source IN \('scheduled', 'manual'\)/);
	assert.match(tildaRuns!, /error_message VARCHAR\(500\) NULL/);
	assert.doesNotMatch(tildaRuns!, /\bJSON\b/i);
});

test('migration checksums are stable across LF and CRLF checkouts', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'b24-app-migrations-'));
	try {
		await writeFile(join(directory, '0001_lf.sql'), 'SELECT 1;\nSELECT 2;\n');
		await writeFile(join(directory, '0002_crlf.sql'), 'SELECT 1;\r\nSELECT 2;\r\n');
		const migrations = await readMigrationFiles(directory);
		assert.equal(migrations[0]!.checksum, migrations[1]!.checksum);
		assert.equal(migrations[1]!.sql, 'SELECT 1;\nSELECT 2;\n');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('reservation schema preserves soft monotonic promises and append-only evidence', async () => {
	const migrations = await readMigrationFiles(projectMigrationsDirectory);
	const byName = new Map(migrations.map((migration) => [migration.filename, migration.sql]));
	const keys = byName.get('0009_create_stock_availability_keys.sql')!;
	const requests = byName.get('0010_create_stock_reservation_requests.sql')!;
	const requestLines = byName.get('0011_create_stock_reservation_request_lines.sql')!;
	const reservations = byName.get('0012_create_stock_reservations.sql')!;
	const lines = byName.get('0013_create_stock_reservation_lines.sql')!;
	const releaseRequests = byName.get('0014_create_stock_reservation_release_requests.sql')!;
	const commands = byName.get('0015_create_stock_reservation_commands.sql')!;
	const events = byName.get('0016_create_stock_reservation_events.sql')!;
	const backfillCheckpoints = byName.get('0017_create_stock_reservation_backfill_checkpoints.sql')!;
	const dealLink = byName.get('0018_add_reservation_deal_link.sql')!;
	const dealLinkEvents = byName.get('0019_add_reservation_deal_link_events.sql')!;
	const manualCommands = byName.get('0020_add_reservation_manual_commands.sql')!;
	const requestComment = byName.get('0021_add_reservation_request_comment.sql')!;

	assert.match(keys, /PRIMARY KEY \(erp_warehouse_name, item_code\)/);
	assert.match(requests, /status IN \('pending', 'approved', 'rejected', 'withdrawn'\)/);
	assert.match(requests, /UNIQUE KEY uq_stock_reservation_requests_source \(source_system, source_type, source_id, source_revision_key\)/);
	assert.match(requestLines, /requested_qty DECIMAL\(21, 9\) NOT NULL/);
	assert.match(requestLines, /requested_qty > 0/);

	assert.match(reservations, /UNIQUE KEY uq_stock_reservations_approved_request \(approved_request_id\)/);
	assert.match(reservations, /source_type = 'deal' AND expires_at IS NOT NULL AND expires_at > approved_at/);
	assert.match(reservations, /source_type <> 'deal' AND expires_at IS NULL/);
	assert.match(reservations, /status IN \('active', 'consumed', 'released', 'cancelled', 'expired', 'shortfall', 'closed', 'pending_reconcile', 'superseded'\)/);
	assert.match(dealLink, /ADD COLUMN deal_id BIGINT UNSIGNED NULL/);
	assert.match(dealLink, /ADD COLUMN deal_link_explicit TINYINT\(1\) NOT NULL DEFAULT 0/);
	assert.match(dealLink, /source_type IN \('deal', 'manual'/);
	assert.match(dealLinkEvents, /'deal_linked', 'deal_unlinked', 'deal_relinked'/);
	assert.match(manualCommands, /'create_manual_reserve', 'link_deal', 'unlink_deal', 'relink_deal'/);
	assert.match(requestComment, /ADD COLUMN request_comment VARCHAR\(1000\) NULL/);

	assert.match(lines, /active_qty DECIMAL\(21, 9\) GENERATED ALWAYS AS \(reserved_qty - consumed_qty - released_qty - shortfall_qty\) STORED/);
	assert.match(lines, /consumed_qty \+ released_qty \+ shortfall_qty <= reserved_qty/);
	assert.match(lines, /FOREIGN KEY \(erp_warehouse_name, item_code\) REFERENCES stock_availability_keys/);
	assert.match(releaseRequests, /CASE WHEN status = 'pending' THEN reservation_id ELSE NULL END/);
	assert.match(releaseRequests, /UNIQUE KEY uq_stock_reservation_release_requests_pending \(pending_reservation_id\)/);

	assert.match(commands, /UNIQUE KEY uq_stock_reservation_commands_idempotency \(idempotency_key\)/);
	assert.match(commands, /request_hash BINARY\(32\) NOT NULL/);
	assert.match(commands, /status IN \('started', 'applied', 'failed', 'pending_reconcile'\)/);
	assert.match(events, /UNIQUE KEY uq_stock_reservation_events_command_order \(command_id, event_index\)/);
	assert.match(events, /event_type IN \('created', 'consumed', 'released', 'expired', 'cancelled', 'shortfall', 'status_changed', 'pending_reconcile', 'superseded'\)/);
	assert.match(events, /FOREIGN KEY \(reservation_line_id, reservation_id\) REFERENCES stock_reservation_lines \(id, reservation_id\)/);
	assert.match(backfillCheckpoints, /UNIQUE KEY uq_stock_reservation_backfill_checkpoints_hash \(plan_hash\)/);
	assert.match(backfillCheckpoints, /bitrix_basket_reservation_records INT UNSIGNED NOT NULL/);
	assert.doesNotMatch(
		[keys, requests, requestLines, reservations, lines, releaseRequests, commands, events, backfillCheckpoints].join('\n'),
		/^\s*(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT)\b/im,
	);
});

test('transfer public identity foundation preserves legacy numbers without runtime activation', async () => {
	const migrations = await readMigrationFiles(projectMigrationsDirectory);
	const byName = new Map(migrations.map((migration) => [migration.filename, migration.sql]));
	const publicId = byName.get('0032_add_stock_transfer_public_id.sql')!;
	const allocator = byName.get('0033_create_stock_transfer_public_ids.sql')!;
	const checkpoints = byName.get('0034_create_stock_transfer_identity_checkpoints.sql')!;

	assert.match(publicId, /ADD COLUMN public_id BIGINT UNSIGNED NULL/);
	assert.match(publicId, /UNIQUE KEY uq_stock_transfer_records_public_id \(public_id\)/);
	assert.doesNotMatch(publicId, /MODIFY COLUMN bitrix_external_id/);
	assert.match(allocator, /public_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT/);
	assert.match(allocator, /UNIQUE KEY uq_stock_transfer_public_ids_legacy \(legacy_bitrix_external_id\)/);
	assert.match(checkpoints, /UNIQUE KEY uq_stock_transfer_identity_checkpoints_hash \(plan_hash\)/);
	assert.match(checkpoints, /assigned_record_count <= source_record_count/);
	assert.doesNotMatch([publicId, allocator, checkpoints].join('\n'), /\bJSON\b/i);
});

test('transfer SQL-first foundation is idempotent and keeps the Bitrix mirror payload-free', async () => {
	const migrations = await readMigrationFiles(projectMigrationsDirectory);
	const byName = new Map(migrations.map((migration) => [migration.filename, migration.sql]));
	const optionalBitrix = byName.get('0035_make_stock_transfer_bitrix_identity_optional.sql')!;
	const commands = byName.get('0036_create_stock_transfer_commands.sql')!;
	const outbox = byName.get('0037_create_stock_transfer_bitrix_outbox.sql')!;

	assert.match(optionalBitrix, /MODIFY COLUMN bitrix_external_id BIGINT UNSIGNED NULL/);
	assert.match(optionalBitrix, /bitrix_external_id IS NULL OR bitrix_external_id > 0/);
	assert.match(commands, /UNIQUE KEY uq_stock_transfer_commands_key \(idempotency_key\)/);
	assert.match(commands, /request_hash BINARY\(32\) NOT NULL/);
	assert.match(commands, /command_kind IN \('create', 'update', 'delete'\)/);
	assert.match(outbox, /UNIQUE KEY uq_stock_transfer_bitrix_outbox_revision \(revision_id, operation_kind\)/);
	assert.match(outbox, /operation_kind IN \('upsert', 'delete'\)/);
	assert.match(outbox, /status IN \('pending', 'processing', 'delivered', 'superseded'\)/);
	assert.match(outbox, /lease_token CHAR\(36\).*locked_until DATETIME\(6\)/s);
	assert.match(outbox, /FOREIGN KEY \(revision_id\) REFERENCES stock_transfer_revisions \(id\).*ON DELETE RESTRICT/);
	assert.doesNotMatch([commands, outbox].join('\n'), /\bJSON\b/i);
});
