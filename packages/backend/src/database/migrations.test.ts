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
	]);
	for (const migration of migrations.slice(0, 7)) {
		assert.match(migration.sql, /^CREATE TABLE IF NOT EXISTS (?:workflow_|supply_mirror_|tilda_)[a-z_]+ \(/);
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
