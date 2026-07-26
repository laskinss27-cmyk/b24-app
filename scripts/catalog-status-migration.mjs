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
if (!['snapshot', 'apply-pilot', 'verify-pilot', 'apply-full', 'verify-full', 'rollback-pilot', 'rollback-full'].includes(mode ?? '')) {
	throw new Error('Unknown --mode');
}
if (!sourcePath || !statePath || !sshKey || !host) {
	throw new Error('Required: --source, --state, --ssh-key and --host');
}

const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (value) => String(value ?? '').trim();
const sourceRows = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const payload = sourceRows
	.filter((row) => row.inCore && (row.nameChanged || clean(row.status)))
	.map((row) => ({
		id: String(row.productId),
		beforeName: clean(row.coreName),
		afterName: row.nameChanged && clean(row.proposedName) ? clean(row.proposedName) : clean(row.coreName),
		status: clean(row.status),
	}))
	.filter((row) => row.beforeName && row.afterName);

const ids = new Set();
for (const row of payload) {
	if (!/^\d+$/.test(row.id) || ids.has(row.id)) throw new Error(`Invalid or duplicate product ID ${row.id}`);
	if (row.afterName.length < 3 || row.afterName.length > 140) throw new Error(`Invalid target name length for ${row.id}`);
	if (/[\u0000-\u001f]/u.test(row.afterName) || /[\u0000-\u001f]/u.test(row.status)) throw new Error(`Control character in ${row.id}`);
	ids.add(row.id);
}

const pilotIds = new Set(['7756', '7852', '10728', '12946', '11336', '16188', '12260', '16072', '7902']);
const scopePayload = (scope) => scope === 'pilot' ? payload.filter((row) => pilotIds.has(row.id)) : payload;
const scopeFromMode = mode?.endsWith('pilot') ? 'pilot' : 'full';

async function runRemote(remoteScript) {
	const child = spawn('ssh', [
		'-i', sshKey,
		'-o', 'BatchMode=yes',
		'-o', 'ConnectTimeout=15',
		host,
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
const hashRows = (rows, fields) => {
	const normalized = rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])))
		.sort((left, right) => fields.map((field) => String(left[field] ?? '')).join('\u0000')
			.localeCompare(fields.map((field) => String(right[field] ?? '')).join('\u0000')));
	return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
};
const statusFieldName = 'Item-b24_product_status';
const statusField = async () => erp.get('Custom Field', statusFieldName);
const ensureStatusField = async () => {
	if (await statusField()) return false;
	await erp.create('Custom Field', {
		dt: 'Item',
		fieldname: 'b24_product_status',
		label: 'Статус товара',
		fieldtype: 'Data',
		insert_after: 'b24_section',
		in_standard_filter: 1,
		in_list_view: 1,
	});
	return true;
};
`;

if (mode === 'snapshot') {
	const remoteScript = `${remoteHelpers}
const payload = ${JSON.stringify(payload)};
const targetSet = new Set(payload.map((row) => row.id));
const hasStatusField = Boolean(await statusField());
const identityFields = [
	'name', 'disabled', 'is_stock_item', 'stock_uom', 'valuation_rate',
	'b24_model', 'b24_article', 'b24_brand', 'b24_section', 'description', 'image',
];
const itemFields = ['name', 'item_name', ...identityFields.filter((field) => field !== 'name')];
if (hasStatusField) itemFields.push('b24_product_status');
const items = (await erp.list('Item', itemFields)).filter((row) => targetSet.has(String(row.name)));
const byId = new Map(items.map((row) => [String(row.name), row]));
const mismatches = payload.flatMap((row) => {
	const actual = byId.get(row.id);
	if (!actual) return [{ id: row.id, reason: 'missing' }];
	if (String(actual.item_name ?? '').trim() !== row.beforeName) {
		return [{ id: row.id, reason: 'source-name', expected: row.beforeName, actual: String(actual.item_name ?? '') }];
	}
	return [];
});
const references = {};
const childFields = ['name', 'parent', 'item_code', 'item_name', 'docstatus'];
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
	const rows = documents.flatMap((document) => (document?.items ?? []).map((row) => ({
		...row,
		parent: row.parent ?? document.name,
	}))).filter((row) => targetSet.has(String(row.item_code ?? '')));
	references[childDoctype] = {
		kind: 'children',
		parentDoctype,
		fields: childFields,
		rows,
		hash: hashRows(rows, childFields),
	};
}
for (const [doctype, fields] of [
	['Bin', ['name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty']],
	['Item Price', ['name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling']],
]) {
	const rows = (await erp.list(doctype, fields)).filter((row) => targetSet.has(String(row.item_code ?? '')));
	references[doctype] = { kind: 'direct', fields, rows, hash: hashRows(rows, fields) };
}
process.stdout.write(JSON.stringify({
	generatedAt: new Date().toISOString(),
	hasStatusField,
	statusFieldDefinition: await statusField(),
	items,
	identityFields,
	identityHash: hashRows(items, identityFields),
	references,
	mismatches,
}));
`;
	const snapshot = await runRemote(remoteScript);
	const state = {
		version: 1,
		generatedAt: new Date().toISOString(),
		sourcePath,
		sourceHash: stableHash(sourceRows),
		payload,
		payloadHash: stableHash(payload),
		pilotIds: [...pilotIds],
		snapshot,
	};
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify({
		mode,
		statePath,
		targets: payload.length,
		renames: payload.filter((row) => row.beforeName !== row.afterName).length,
		statuses: payload.filter((row) => row.status).length,
		pilotTargets: scopePayload('pilot').length,
		preflightMismatches: snapshot.mismatches,
		statusFieldAlreadyExisted: snapshot.hasStatusField,
	}, null, 2));
	if (snapshot.mismatches.length) process.exitCode = 1;
} else {
	const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
	if (state.sourceHash !== stableHash(sourceRows) || state.payloadHash !== stableHash(payload)) {
		throw new Error('Source changed after the rollback snapshot');
	}
	if (state.snapshot.mismatches.length) throw new Error('Snapshot contains preflight mismatches');
	const selected = scopePayload(scopeFromMode);
	const beforeById = new Map(state.snapshot.items.map((row) => [String(row.name), row]));

	if (mode.startsWith('apply-')) {
		const remoteScript = `${remoteHelpers}
const payload = ${JSON.stringify(selected)};
const before = ${JSON.stringify(Object.fromEntries(selected.map((row) => [row.id, beforeById.get(row.id)])))};
const createdField = await ensureStatusField();
const completed = [];
const rollback = async () => {
	for (const id of [...completed].reverse()) {
		const row = before[id];
		if (row) await erp.update('Item', id, {
			item_name: String(row.item_name ?? ''),
			b24_product_status: String(row.b24_product_status ?? ''),
		});
	}
};
try {
	for (let offset = 0; offset < payload.length; offset += 4) {
		const batch = payload.slice(offset, offset + 4);
		const current = await Promise.all(batch.map((row) => erp.get('Item', row.id)));
		for (let index = 0; index < batch.length; index += 1) {
			const row = batch[index];
			const actual = current[index];
			const currentName = String(actual?.item_name ?? '').trim();
			const currentStatus = String(actual?.b24_product_status ?? '').trim();
			const isBefore = currentName === row.beforeName;
			const isAfter = currentName === row.afterName && currentStatus === row.status;
			if (!actual || (!isBefore && !isAfter)) throw new Error('Precondition mismatch for ' + row.id);
		}
		await Promise.all(batch.map(async (row) => {
			await erp.update('Item', row.id, { item_name: row.afterName, b24_product_status: row.status });
			const actual = await erp.get('Item', row.id);
			if (String(actual?.item_name ?? '').trim() !== row.afterName
				|| String(actual?.b24_product_status ?? '').trim() !== row.status) {
				throw new Error('Read-back mismatch for ' + row.id);
			}
			completed.push(row.id);
		}));
	}
	process.stdout.write(JSON.stringify({ createdField, completed: completed.length, rolledBack: false }));
} catch (error) {
	await rollback();
	process.stdout.write(JSON.stringify({
		createdField,
		completed: completed.length,
		rolledBack: true,
		error: String(error?.message ?? error),
	}));
	process.exitCode = 1;
}
`;
		const result = await runRemote(remoteScript);
		console.log(JSON.stringify({ mode, targets: selected.length, ...result }, null, 2));
	} else if (mode.startsWith('verify-')) {
		const referenceSnapshot = state.snapshot.references;
		const remoteScript = `${remoteHelpers}
const payload = ${JSON.stringify(selected)};
const targetSet = new Set(${JSON.stringify(payload.map((row) => row.id))});
const identityFields = ${JSON.stringify(state.snapshot.identityFields)};
const allTargetSet = new Set(${JSON.stringify(payload.map((row) => row.id))});
const items = (await erp.list('Item', ['item_name', 'b24_product_status', ...identityFields]))
	.filter((row) => allTargetSet.has(String(row.name)));
const byId = new Map(items.map((row) => [String(row.name), row]));
const mismatches = payload.flatMap((row) => {
	const actual = byId.get(row.id);
	const reasons = [];
	if (!actual) reasons.push('missing');
	if (String(actual?.item_name ?? '').trim() !== row.afterName) reasons.push('item_name');
	if (String(actual?.b24_product_status ?? '').trim() !== row.status) reasons.push('status');
	return reasons.length ? [{ id: row.id, reasons }] : [];
});
const identityHash = hashRows(items, identityFields);
const referenceSnapshot = ${JSON.stringify(referenceSnapshot)};
const changedReferences = [];
for (const [doctype, saved] of Object.entries(referenceSnapshot)) {
	const savedNames = new Set(saved.rows.map((row) => String(row.name)));
	let current;
	if (saved.kind === 'children') {
		const parentNames = [...new Set(saved.rows.map((row) => String(row.parent)))];
		const documents = [];
		for (let offset = 0; offset < parentNames.length; offset += 8) {
			documents.push(...await Promise.all(parentNames.slice(offset, offset + 8)
				.map((name) => erp.get(saved.parentDoctype, name))));
		}
		current = documents.flatMap((document) => (document?.items ?? []).map((row) => ({
			...row,
			parent: row.parent ?? document.name,
		}))).filter((row) => savedNames.has(String(row.name)));
	} else {
		current = (await erp.list(doctype, saved.fields)).filter((row) => savedNames.has(String(row.name)));
	}
	const hash = hashRows(current, saved.fields);
	if (hash !== saved.hash) changedReferences.push({ doctype, before: saved.hash, after: hash });
}
process.stdout.write(JSON.stringify({ checked: payload.length, mismatches, identityHash, changedReferences }));
`;
		const result = await runRemote(remoteScript);
		const safe = result.mismatches.length === 0
			&& result.identityHash === state.snapshot.identityHash
			&& result.changedReferences.length === 0;
		if (!safe) {
			const rollbackMode = scopeFromMode === 'pilot' ? 'rollback-pilot' : 'rollback-full';
			const rollbackScript = `${remoteHelpers}
const rows = ${JSON.stringify(selected.map((row) => beforeById.get(row.id)).filter(Boolean))};
await ensureStatusField();
for (let offset = 0; offset < rows.length; offset += 4) {
	await Promise.all(rows.slice(offset, offset + 4).map((row) => erp.update('Item', String(row.name), {
		item_name: String(row.item_name ?? ''),
		b24_product_status: String(row.b24_product_status ?? ''),
	})));
}
process.stdout.write(JSON.stringify({ restored: rows.length }));
`;
			const rollback = await runRemote(rollbackScript);
			console.log(JSON.stringify({ mode, safe: false, ...result, automaticRollback: { mode: rollbackMode, ...rollback } }, null, 2));
			process.exitCode = 1;
		} else {
			console.log(JSON.stringify({ mode, safe: true, ...result }, null, 2));
		}
	} else {
		const remoteScript = `${remoteHelpers}
const rows = ${JSON.stringify(selected.map((row) => beforeById.get(row.id)).filter(Boolean))};
await ensureStatusField();
for (let offset = 0; offset < rows.length; offset += 4) {
	await Promise.all(rows.slice(offset, offset + 4).map((row) => erp.update('Item', String(row.name), {
		item_name: String(row.item_name ?? ''),
		b24_product_status: String(row.b24_product_status ?? ''),
	})));
}
const mismatches = [];
for (const row of rows) {
	const actual = await erp.get('Item', String(row.name));
	if (String(actual?.item_name ?? '') !== String(row.item_name ?? '')
		|| String(actual?.b24_product_status ?? '') !== String(row.b24_product_status ?? '')) {
		mismatches.push(String(row.name));
	}
}
process.stdout.write(JSON.stringify({ restored: rows.length, mismatches }));
`;
		const result = await runRemote(remoteScript);
		console.log(JSON.stringify({ mode, ...result }, null, 2));
		if (result.mismatches.length) process.exitCode = 1;
	}
}
