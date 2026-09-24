import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { B24Client } from './packages/backend/dist/b24/client.js';
import { ErpClient } from './packages/backend/dist/erp/client.js';

const input = globalThis.__TASK_INPUT__;
if (!input || typeof input !== 'object') throw new Error('Missing task input');
const groupName = String(input.groupName ?? '').trim();
const candidates = Array.isArray(input.candidates) ? input.candidates : [];
const operationId = String(input.operationId ?? '').replace(/[^a-zA-Z0-9_-]/gu, '');
if (groupName !== 'товары под заказ') throw new Error('Unexpected group name');
if (!operationId || candidates.length === 0) throw new Error('Missing operation data');
if (!candidates.every((row) => typeof row.canonical_name === 'string' && row.canonical_name.trim())) {
	throw new Error('Every candidate must have a canonical_name');
}

const webhook = String(process.env.CATALOG_WRITE_WEBHOOK ?? process.env.DEV_WEBHOOK ?? '').replace(/\/$/u, '');
if (!webhook) throw new Error('Catalog write webhook is not configured');
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook }, requestsPerSecond: 7 });
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');

const fieldValue = (value) => value && typeof value === 'object' && 'value' in value ? value.value : value;
const identity = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replaceAll('ё', 'е').replace(/[^a-zа-я0-9]+/gu, '');
const chunks = (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size));
const statePath = `/tmp/b24-supplier-import-${operationId}.json`;

async function listB24(method, resultKey, params) {
	const rows = [];
	const seen = new Set();
	for (let start = 0; start < 100000; start += 50) {
		const page = await b24.call(method, { ...params, start });
		const pageRows = Array.isArray(page?.[resultKey]) ? page[resultKey] : [];
		let fresh = 0;
		for (const row of pageRows) {
			const id = String(fieldValue(row.id) ?? '');
			if (id && seen.has(id)) continue;
			if (id) seen.add(id);
			rows.push(row);
			fresh += 1;
		}
		if (pageRows.length < 50 || fresh === 0) break;
	}
	return rows;
}

async function snapshot() {
	const erpFields = ['name', 'item_name', 'b24_article', 'b24_model', 'b24_brand', 'b24_section', 'is_stock_item', 'disabled', 'modified'];
	const [sections, products, erpItems] = await Promise.all([
		listB24('catalog.section.list', 'sections', { filter: { iblockId: 24 }, select: ['id', 'iblockId', 'name', 'iblockSectionId'], order: { id: 'ASC' } }),
		listB24('catalog.product.list', 'products', { filter: { iblockId: 24 }, select: ['id', 'iblockId', 'name', 'iblockSectionId', 'active'], order: { id: 'ASC' } }),
		erp.list('Item', erpFields, [['item_group', '=', 'Каталог Б24'], ['disabled', '=', 0]], 0),
	]);
	const normalizedErp = erpItems
		.map((item) => Object.fromEntries(erpFields.map((field) => [field, item[field] ?? null])))
		.sort((left, right) => String(left.name).localeCompare(String(right.name), 'en'));
	const catalogHash = createHash('sha256').update(JSON.stringify(normalizedErp)).digest('hex');
	const sectionMatches = sections.filter((row) => String(fieldValue(row.name) ?? '').trim().toLowerCase() === groupName.toLowerCase());
	const existing = new Map();
	for (const row of products) {
		const key = identity(fieldValue(row.name));
		if (key) existing.set(key, [...(existing.get(key) ?? []), { system: 'b24', id: Number(fieldValue(row.id)), name: String(fieldValue(row.name) ?? '') }]);
	}
	for (const row of erpItems) {
		const key = identity(row.item_name);
		if (key) existing.set(key, [...(existing.get(key) ?? []), { system: 'erp', id: String(row.name), name: String(row.item_name ?? '') }]);
	}
	const runtimeDuplicates = [];
	const creatable = [];
	for (const row of candidates) {
		const matches = existing.get(String(row.identity_key ?? identity(row.canonical_name))) ?? [];
		if (matches.length) runtimeDuplicates.push({ canonical_name: row.canonical_name, matches });
		else creatable.push(row);
	}
	return { catalogHash, sections: sectionMatches.map((row) => ({ id: Number(fieldValue(row.id)), name: String(fieldValue(row.name) ?? '') })), runtimeDuplicates, creatable, counts: { b24Products: products.length, erpItems: erpItems.length } };
}

async function writeState(state) {
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function rollback(state) {
	const errors = [];
	for (const id of [...state.erpCreated].reverse()) {
		try { await erp.delete('Item', String(id)); } catch (error) { errors.push(`ERP ${id}: ${String(error)}`); }
	}
	for (const part of chunks([...state.b24Created].reverse(), 50)) {
		const calls = Object.fromEntries(part.map((id, index) => [`d${index}`, { method: 'catalog.product.delete', params: { id } }]));
		try {
			const result = await b24.callBatch(calls, false);
			for (const [key, error] of Object.entries(result.result_error ?? {})) errors.push(`B24 ${part[Number(key.slice(1))]}: ${JSON.stringify(error)}`);
		} catch (error) { errors.push(`B24 batch: ${String(error)}`); }
	}
	if (state.sectionCreated && state.sectionId) {
		try { await b24.call('catalog.section.delete', { id: state.sectionId }); } catch (error) { errors.push(`section ${state.sectionId}: ${String(error)}`); }
	}
	state.status = errors.length ? 'rollback_incomplete' : 'rolled_back';
	state.rollbackErrors = errors;
	state.finishedAt = new Date().toISOString();
	await writeState(state);
	return errors;
}

async function verify(createdRows, sectionId) {
	const products = await listB24('catalog.product.list', 'products', {
		filter: { iblockId: 24, iblockSectionId: sectionId },
		select: ['id', 'iblockId', 'name', 'iblockSectionId', 'detailText', 'previewText', 'detailPicture', 'previewPicture', 'quantity', 'purchasingPrice'],
		order: { id: 'ASC' },
	});
	const expected = new Map(createdRows.map((row) => [Number(row.id), row.name]));
	const found = new Map(products.map((row) => [Number(fieldValue(row.id)), row]));
	const missingB24 = [];
	const invalidB24 = [];
	for (const [id, name] of expected) {
		const row = found.get(id);
		if (!row) { missingB24.push(id); continue; }
		const issues = [];
		if (String(fieldValue(row.name) ?? '') !== name) issues.push('name');
		if (Number(fieldValue(row.iblockSectionId) ?? 0) !== sectionId) issues.push('section');
		if (String(fieldValue(row.detailText) ?? '').trim() || String(fieldValue(row.previewText) ?? '').trim()) issues.push('description');
		if (fieldValue(row.detailPicture) || fieldValue(row.previewPicture)) issues.push('picture');
		if (Math.abs(Number(fieldValue(row.quantity) ?? 0)) > 1e-9) issues.push('quantity');
		if (Math.abs(Number(fieldValue(row.purchasingPrice) ?? 0)) > 1e-9) issues.push('purchasingPrice');
		if (issues.length) invalidB24.push({ id, issues });
	}
	const ids = createdRows.map((row) => String(row.id));
	const erpRows = [];
	const priceRows = [];
	const binRows = [];
	for (const part of chunks(ids, 200)) {
		erpRows.push(...await erp.list('Item', ['name', 'item_name', 'b24_section', 'description', 'is_stock_item'], [['name', 'in', part]], 0));
		priceRows.push(...await erp.list('Item Price', ['name', 'item_code', 'price_list_rate'], [['item_code', 'in', part]], 0));
		binRows.push(...await erp.list('Bin', ['name', 'item_code', 'actual_qty'], [['item_code', 'in', part]], 0));
	}
	const erpById = new Map(erpRows.map((row) => [String(row.name), row]));
	const missingErp = [];
	const invalidErp = [];
	for (const row of createdRows) {
		const item = erpById.get(String(row.id));
		if (!item) { missingErp.push(row.id); continue; }
		const issues = [];
		if (String(item.item_name ?? '') !== row.name) issues.push('name');
		if (String(item.b24_section ?? '') !== groupName) issues.push('section');
		if (String(item.description ?? '').trim()) issues.push('description');
		if (Number(item.is_stock_item ?? 0) !== 1) issues.push('is_stock_item');
		if (issues.length) invalidErp.push({ id: row.id, issues });
	}
	return {
		ok: missingB24.length === 0 && invalidB24.length === 0 && missingErp.length === 0 && invalidErp.length === 0 && priceRows.length === 0 && binRows.length === 0,
		b24: { sectionProducts: products.length, verified: expected.size, missing: missingB24, invalid: invalidB24 },
		erp: { verified: erpRows.length, missing: missingErp, invalid: invalidErp, itemPrices: priceRows.length, bins: binRows.length },
	};
}

const before = await snapshot();
if (input.mode === 'audit') {
	process.stdout.write(JSON.stringify({
		generatedAt: new Date().toISOString(), mode: 'audit', groupName,
		catalogHash: before.catalogHash, sections: before.sections,
		runtimeDuplicates: before.runtimeDuplicates.slice(0, 100),
		creatable: before.creatable.length, counts: before.counts,
	}));
} else if (input.mode === 'apply') {
	if (before.catalogHash !== input.expectedCatalogHash) throw new Error(`Catalog changed since proposal: expected ${input.expectedCatalogHash}, got ${before.catalogHash}`);
	if (before.sections.length > 1) throw new Error(`Multiple sections named ${groupName}`);
	const names = new Set();
	for (const row of before.creatable) {
		const name = row.canonical_name.trim();
		if (name.length > 140) throw new Error(`Name is longer than 140 chars: ${name}`);
		const key = identity(name);
		if (!key || names.has(key)) throw new Error(`Duplicate/empty identity in creatable set: ${name}`);
		names.add(key);
	}
	const state = {
		operationId, status: 'in_progress', startedAt: new Date().toISOString(), groupName,
		sectionId: before.sections[0]?.id ?? 0, sectionCreated: false,
		b24Created: [], erpCreated: [], createdRows: [], runtimeDuplicates: before.runtimeDuplicates,
	};
	await writeState(state);
	try {
		if (!state.sectionId) {
			const added = await b24.call('catalog.section.add', { fields: { iblockId: 24, name: groupName, active: 'Y', sort: 900 } });
			state.sectionId = Number(added?.section?.id ?? 0);
			if (!state.sectionId) throw new Error('catalog.section.add did not return an id');
			state.sectionCreated = true;
			await writeState(state);
		}
		let completed = 0;
		for (const part of chunks(before.creatable, 40)) {
			const calls = Object.fromEntries(part.map((row, index) => [`p${index}`, { method: 'catalog.product.add', params: { fields: { iblockId: 24, name: row.canonical_name.trim(), type: 1, measure: 9, active: 'Y', iblockSectionId: state.sectionId } } }]));
			const result = await b24.callBatch(calls, false);
			for (let index = 0; index < part.length; index += 1) {
				const key = `p${index}`;
				const value = result.result?.[key];
				const id = Number(value?.element?.id ?? 0);
				if (id) {
					state.b24Created.push(id);
					state.createdRows.push({ id, name: part[index].canonical_name.trim(), source: part[index].source });
				}
			}
			await writeState(state);
			if (Object.keys(result.result_error ?? {}).length || state.createdRows.length !== completed + part.length) {
				throw new Error(`B24 batch failed: ${JSON.stringify(result.result_error ?? {})}`);
			}
			for (const row of state.createdRows.slice(completed)) {
				if (await erp.get('Item', String(row.id))) throw new Error(`ERP item ${row.id} already exists`);
				await erp.create('Item', {
					item_code: String(row.id), item_name: row.name, item_group: 'Каталог Б24', stock_uom: 'шт', is_stock_item: 1,
					description: '', b24_model: '', b24_article: '', b24_brand: '', b24_section: groupName,
				});
				state.erpCreated.push(row.id);
				if (state.erpCreated.length % 10 === 0) await writeState(state);
			}
			completed = state.createdRows.length;
			await writeState(state);
			process.stderr.write(`created ${completed}/${before.creatable.length}\n`);
		}
		const verification = await verify(state.createdRows, state.sectionId);
		if (!verification.ok) throw new Error(`Verification failed: ${JSON.stringify(verification).slice(0, 4000)}`);
		state.status = 'complete';
		state.finishedAt = new Date().toISOString();
		state.verification = verification;
		await writeState(state);
		process.stdout.write(JSON.stringify({
			generatedAt: new Date().toISOString(), mode: 'apply', status: state.status, groupName,
			sectionId: state.sectionId, sectionCreated: state.sectionCreated,
			created: state.createdRows.length, runtimeDuplicates: state.runtimeDuplicates.length,
			createdBySource: Object.fromEntries([...new Set(state.createdRows.map((row) => row.source))].sort().map((source) => [source, state.createdRows.filter((row) => row.source === source).length])),
			verification, statePath,
		}));
	} catch (error) {
		state.failure = String(error);
		await writeState(state);
		const rollbackErrors = await rollback(state);
		throw new Error(`${String(error)}; rollback=${rollbackErrors.length ? rollbackErrors.join(' | ') : 'complete'}`);
	}
} else {
	throw new Error(`Unsupported mode: ${input.mode}`);
}
