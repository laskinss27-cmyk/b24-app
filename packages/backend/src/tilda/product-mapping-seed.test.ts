import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTildaProductMappingSeed, readTildaProductMappingSeed } from './product-mapping-seed.js';

const seedPath = fileURLToPath(new URL('../../migrations/data/tilda-product-mappings-2026-08-21.csv', import.meta.url));

test('versioned Tilda mapping seed preserves the audited catalog identities', async () => {
	const rows = await readTildaProductMappingSeed(seedPath);
	assert.equal(rows.length, 177);
	assert.equal(rows.filter((row) => row.rowKind === 'parent').length, 131);
	assert.equal(rows.filter((row) => row.rowKind === 'variant').length, 46);
	assert.equal(rows.filter((row) => row.mappingStatus === 'confirmed').length, 134);
	assert.equal(rows.filter((row) => row.mappingStatus === 'ignored').length, 43);
	assert.equal(rows.filter((row) => row.mappingStatus === 'unresolved').length, 0);
	assert.equal(rows.filter((row) => row.tildaSku).length, 150);
	assert.equal(rows.filter((row) => row.auditSource === 'manual_review:missing_in_erp').length, 16);
	assert.equal(rows.filter((row) => row.auditSource === 'tilda_export:no_stock_sku').length, 27);

	const oldSku = rows.find((row) => row.tildaSku === '111024');
	assert.deepEqual(oldSku && {
		tildaUid: oldSku.tildaUid,
		tildaExternalId: oldSku.tildaExternalId,
		erpItemCode: oldSku.erpItemCode,
		mappingStatus: oldSku.mappingStatus,
	}, {
		tildaUid: '390763619852',
		tildaExternalId: 'g8uv6mzPGYZLy70XvjX0',
		erpItemCode: '18184',
		mappingStatus: 'confirmed',
	});
});

test('mapping seed parser rejects incomplete confirmed rows and duplicate identifiers', () => {
	const header = 'tilda_uid;tilda_external_id;tilda_sku;tilda_title;row_kind;parent_tilda_uid;variant_label;erp_item_code;mapping_status;audit_source;source_seen_at;confirmed_at';
	assert.throws(() => parseTildaProductMappingSeed(`${header}\n1;ext;old;Title;parent;;;;confirmed;audit;2026-08-20 11:04:00.000000;\n`), /incomplete/u);
	assert.throws(() => parseTildaProductMappingSeed([
		header,
		'1;ext-1;;Parent;parent;;;;ignored;audit;2026-08-20 11:04:00.000000;',
		'1;ext-2;;Other;parent;;;;ignored;audit;2026-08-20 11:04:00.000000;',
	].join('\n')), /Duplicate Tilda UID/u);
});
