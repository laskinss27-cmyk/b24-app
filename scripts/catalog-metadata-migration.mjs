import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}
const mode = args.get('mode');
const sourcePath = path.resolve(args.get('source') ?? '');
const statePath = path.resolve(args.get('state') ?? '');
const sshKey = args.get('ssh-key') ?? process.env['B24_SSH_KEY'];
const host = args.get('host') ?? process.env['B24_SSH_HOST'];
const container = args.get('container') ?? 'b24-backend';
if (!['snapshot', 'apply', 'verify', 'rollback', 'verify-rollback'].includes(mode ?? '')) throw new Error('Unknown --mode');
if (!sourcePath || !statePath || !sshKey || !host) throw new Error('Required: --source, --state, --ssh-key and --host');

const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const payload = source.payload;
const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
if (source.version !== 1 || !Array.isArray(payload) || !payload.length) throw new Error('Invalid source payload');
const ids = new Set();
for (const row of payload) {
	if (!/^\d+$/.test(row.id) || ids.has(row.id)) throw new Error(`Invalid or duplicate ID ${row.id}`);
	if (row.metadata && (!row.metadata.name || !row.metadata.model)) throw new Error(`Empty name/model ${row.id}`);
	if (row.content?.version !== 1 || !Array.isArray(row.content.attributes)) throw new Error(`Invalid content ${row.id}`);
	ids.add(row.id);
}

async function runRemote(remoteScript) {
	const child = spawn('ssh', [
		'-i', sshKey, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host,
		`docker exec -i ${container} node --input-type=module`,
	], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
	const stdout = [];
	const stderr = [];
	child.stdout.on('data', (chunk) => stdout.push(chunk));
	child.stderr.on('data', (chunk) => stderr.push(chunk));
	child.stdin.end(remoteScript, 'utf8');
	const exitCode = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	const errorText = Buffer.concat(stderr).toString('utf8').trim();
	if (exitCode !== 0) throw new Error(`Remote command failed (${exitCode}): ${errorText.slice(0, 3000)}`);
	const text = Buffer.concat(stdout).toString('utf8').trim();
	return text ? JSON.parse(text) : {};
}

const remoteHelpers = String.raw`
import { createHash } from 'node:crypto';
import { ErpClient } from './packages/backend/dist/erp/client.js';
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const stableRowsHash = (rows, fields) => {
	const normalized = rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])))
		.sort((a, b) => fields.map((field) => String(a[field] ?? '')).join('\u0000')
			.localeCompare(fields.map((field) => String(b[field] ?? '')).join('\u0000')));
	return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
};
const fieldName = 'Item-b24_catalog_content';
const contentField = async () => erp.get('Custom Field', fieldName);
const ensureContentField = async () => {
	if (await contentField()) return false;
	await erp.create('Custom Field', {
		dt: 'Item',
		fieldname: 'b24_catalog_content',
		label: 'Структурированное описание товара (JSON)',
		fieldtype: 'Long Text',
		insert_after: 'b24_filter_attributes',
	});
	return true;
};
`;

if (mode === 'snapshot') {
	const remoteScript = `${remoteHelpers}
const payload = ${JSON.stringify(payload)};
const targetSet = new Set(payload.map((row) => row.id));
const hasContentField = Boolean(await contentField());
const mutableFields = ['item_name', 'b24_model', 'b24_brand', 'b24_product_status'];
if (hasContentField) mutableFields.push('b24_catalog_content');
const immutableFields = [
	'name', 'disabled', 'is_stock_item', 'stock_uom', 'valuation_rate',
	'b24_article', 'b24_section', 'description', 'image',
	'b24_filter_category', 'b24_filter_attributes', 'b24_filter_schema_version', 'b24_filter_updated_at',
];
const itemFields = [...new Set([...mutableFields, ...immutableFields])];
const items = (await erp.list('Item', itemFields)).filter((row) => targetSet.has(String(row.name)));
const missing = payload.map((row) => row.id).filter((id) => !items.some((item) => String(item.name) === id));
const references = {};
for (const [parentDoctype, childDoctype] of [
	['Sales Order', 'Sales Order Item'],
	['Delivery Note', 'Delivery Note Item'],
	['Stock Entry', 'Stock Entry Detail'],
	['Purchase Receipt', 'Purchase Receipt Item'],
	['Sales Invoice', 'Sales Invoice Item'],
]) {
	const parents = await erp.list(parentDoctype, ['name']);
	const documents = [];
	for (let offset = 0; offset < parents.length; offset += 8) {
		documents.push(...await Promise.all(parents.slice(offset, offset + 8).map((row) => erp.get(parentDoctype, String(row.name)))));
	}
	const fields = ['name', 'parent', 'item_code', 'item_name', 'qty', 'rate', 'amount', 'docstatus'];
	const rows = documents.flatMap((document) => (document?.items ?? []).map((row) => ({
		...row, parent: row.parent ?? document.name, docstatus: document.docstatus,
	}))).filter((row) => targetSet.has(String(row.item_code ?? '')));
	references[childDoctype] = { kind: 'children', parentDoctype, fields, rows, hash: stableRowsHash(rows, fields) };
}
for (const [doctype, fields] of [
	['Bin', ['name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty']],
	['Item Price', ['name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling']],
]) {
	const rows = (await erp.list(doctype, fields)).filter((row) => targetSet.has(String(row.item_code ?? '')));
	references[doctype] = { kind: 'direct', fields, rows, hash: stableRowsHash(rows, fields) };
}
process.stdout.write(JSON.stringify({
	generatedAt: new Date().toISOString(),
	hasContentField,
	contentFieldDefinition: await contentField(),
	items,
	mutableFields,
	immutableFields,
	immutableHash: stableRowsHash(items, immutableFields),
	references,
	missing,
}));
`;
	const snapshot = await runRemote(remoteScript);
	const state = {
		version: 1,
		generatedAt: new Date().toISOString(),
		sourcePath,
		sourceHash: stableHash(source),
		payloadHash: stableHash(payload),
		snapshot,
	};
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify({
		mode,
		statePath,
		targets: payload.length,
		metadataTargets: payload.filter((row) => row.metadata).length,
		missing: snapshot.missing,
		hasContentField: snapshot.hasContentField,
		references: Object.fromEntries(Object.entries(snapshot.references).map(([name, value]) => [name, value.rows.length])),
	}, null, 2));
	if (snapshot.missing.length) process.exitCode = 1;
} else {
	const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
	if (state.sourceHash !== stableHash(source) || state.payloadHash !== stableHash(payload)) throw new Error('Source changed after snapshot');
	if (state.snapshot.missing.length) throw new Error('Snapshot contains missing products');
	const beforeById = new Map(state.snapshot.items.map((row) => [String(row.name), row]));
	const rollbackRows = payload.map((row) => beforeById.get(row.id)).filter(Boolean);

	if (mode === 'apply') {
		const remoteScript = `${remoteHelpers}
const payload = ${JSON.stringify(payload)};
const before = ${JSON.stringify(Object.fromEntries(rollbackRows.map((row) => [String(row.name), row])))};
const createdField = await ensureContentField();
const completed = [];
const restore = async () => {
	for (let offset = 0; offset < completed.length; offset += 4) {
		await Promise.all(completed.slice(offset, offset + 4).map(async (id) => {
			const row = before[id];
			await erp.update('Item', id, {
				item_name: row.item_name ?? '',
				b24_model: row.b24_model ?? '',
				b24_brand: row.b24_brand ?? '',
				b24_product_status: row.b24_product_status ?? '',
				b24_catalog_content: row.b24_catalog_content ?? '',
			});
		}));
	}
};
try {
	for (let offset = 0; offset < payload.length; offset += 4) {
		const batch = payload.slice(offset, offset + 4);
		await Promise.all(batch.map(async (row) => {
			const saved = before[row.id];
			const actual = await erp.get('Item', row.id);
			if (!actual || String(actual.item_name ?? '') !== String(saved.item_name ?? '')
				|| String(actual.b24_model ?? '') !== String(saved.b24_model ?? '')
				|| String(actual.b24_brand ?? '') !== String(saved.b24_brand ?? '')
				|| String(actual.b24_product_status ?? '') !== String(saved.b24_product_status ?? '')) {
				throw new Error('Precondition mismatch for ' + row.id);
			}
			const patch = { b24_catalog_content: JSON.stringify(row.content) };
			if (row.metadata) {
				patch.item_name = row.metadata.name;
				patch.b24_model = row.metadata.model;
				patch.b24_brand = row.metadata.brand;
				patch.b24_product_status = row.metadata.status;
			}
			await erp.update('Item', row.id, patch);
			const readBack = await erp.get('Item', row.id);
			if (String(readBack?.b24_catalog_content ?? '') !== patch.b24_catalog_content
				|| (row.metadata && (
					String(readBack?.item_name ?? '') !== row.metadata.name
					|| String(readBack?.b24_model ?? '') !== row.metadata.model
					|| String(readBack?.b24_brand ?? '') !== row.metadata.brand
					|| String(readBack?.b24_product_status ?? '') !== row.metadata.status
				))) throw new Error('Read-back mismatch for ' + row.id);
			completed.push(row.id);
		}));
	}
	process.stdout.write(JSON.stringify({ createdField, completed: completed.length, rolledBack: false }));
} catch (error) {
	await restore();
	process.stdout.write(JSON.stringify({ createdField, completed: completed.length, rolledBack: true, error: String(error?.message ?? error) }));
	process.exitCode = 1;
}
`;
		const result = await runRemote(remoteScript);
		console.log(JSON.stringify({ mode, targets: payload.length, ...result }, null, 2));
	} else if (mode === 'rollback') {
		const remoteScript = `${remoteHelpers}
await ensureContentField();
const rows = ${JSON.stringify(rollbackRows)};
for (let offset = 0; offset < rows.length; offset += 4) {
	await Promise.all(rows.slice(offset, offset + 4).map((row) => erp.update('Item', String(row.name), {
		item_name: row.item_name ?? '',
		b24_model: row.b24_model ?? '',
		b24_brand: row.b24_brand ?? '',
		b24_product_status: row.b24_product_status ?? '',
		b24_catalog_content: row.b24_catalog_content ?? '',
	})));
}
process.stdout.write(JSON.stringify({ restored: rows.length }));
`;
		console.log(JSON.stringify({ mode, ...await runRemote(remoteScript) }, null, 2));
	} else {
		const verifyRollback = mode === 'verify-rollback';
		const expected = verifyRollback
			? rollbackRows.map((row) => ({
				id: String(row.name),
				metadata: {
					name: String(row.item_name ?? ''),
					model: String(row.b24_model ?? ''),
					brand: String(row.b24_brand ?? ''),
					status: String(row.b24_product_status ?? ''),
				},
				contentString: String(row.b24_catalog_content ?? ''),
			}))
			: payload.map((row) => ({
				...row,
				contentString: JSON.stringify(row.content),
			}));
		const remoteScript = `${remoteHelpers}
const expected = ${JSON.stringify(expected)};
const targetSet = new Set(expected.map((row) => row.id));
const immutableFields = ${JSON.stringify(state.snapshot.immutableFields)};
const items = (await erp.list('Item', [
	...immutableFields, 'item_name', 'b24_model', 'b24_brand', 'b24_product_status', 'b24_catalog_content',
])).filter((row) => targetSet.has(String(row.name)));
const byId = new Map(items.map((row) => [String(row.name), row]));
const mismatches = expected.flatMap((row) => {
	const actual = byId.get(row.id);
	const reasons = [];
	if (!actual) reasons.push('missing');
	if (row.metadata) {
		if (String(actual?.item_name ?? '') !== row.metadata.name) reasons.push('name');
		if (String(actual?.b24_model ?? '') !== row.metadata.model) reasons.push('model');
		if (String(actual?.b24_brand ?? '') !== row.metadata.brand) reasons.push('brand');
		if (String(actual?.b24_product_status ?? '') !== row.metadata.status) reasons.push('status');
	}
	if (String(actual?.b24_catalog_content ?? '') !== row.contentString) reasons.push('content');
	return reasons.length ? [{ id: row.id, reasons }] : [];
});
const changedReferences = [];
const referenceSnapshot = ${JSON.stringify(state.snapshot.references)};
for (const [doctype, saved] of Object.entries(referenceSnapshot)) {
	const savedNames = new Set(saved.rows.map((row) => String(row.name)));
	let current;
	if (saved.kind === 'children') {
		const parentNames = [...new Set(saved.rows.map((row) => String(row.parent)))];
		const documents = [];
		for (let offset = 0; offset < parentNames.length; offset += 8) {
			documents.push(...await Promise.all(parentNames.slice(offset, offset + 8).map((name) => erp.get(saved.parentDoctype, name))));
		}
		current = documents.flatMap((document) => (document?.items ?? []).map((row) => ({
			...row, parent: row.parent ?? document.name, docstatus: document.docstatus,
		}))).filter((row) => savedNames.has(String(row.name)));
	} else {
		current = (await erp.list(doctype, saved.fields)).filter((row) => savedNames.has(String(row.name)));
	}
	const hash = stableRowsHash(current, saved.fields);
	if (hash !== saved.hash) changedReferences.push({ doctype, before: saved.hash, after: hash });
}
process.stdout.write(JSON.stringify({
	checked: expected.length,
	mismatches,
	immutableHash: stableRowsHash(items, immutableFields),
	changedReferences,
}));
`;
		const result = await runRemote(remoteScript);
		const safe = result.mismatches.length === 0
			&& result.immutableHash === state.snapshot.immutableHash
			&& result.changedReferences.length === 0;
		console.log(JSON.stringify({ mode, safe, ...result }, null, 2));
		if (!safe) process.exitCode = 1;
	}
}
