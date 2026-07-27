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
const productsPath = args.get('products') ? path.resolve(args.get('products')) : '';
const sshKey = args.get('ssh-key') ?? process.env['B24_SSH_KEY'];
const host = args.get('host') ?? process.env['B24_SSH_HOST'];
const container = args.get('container') ?? 'b24-backend';
if (!['snapshot', 'attach-products', 'apply', 'verify', 'rollback', 'verify-rollback'].includes(mode ?? '')) throw new Error('Unknown --mode');
if (!sourcePath || !statePath || !sshKey || !host) throw new Error('Required: --source, --state, --ssh-key and --host');

const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
if (source.version !== 1 || !Array.isArray(source.rows) || source.rows.length !== 199) throw new Error('Invalid source payload');
const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceHash = stableHash(source);
const marker = `shelly-marketplace-${sourceHash.slice(0, 12)}`;

async function runRemote(remoteScript, timeoutMs = 900_000) {
	const child = spawn('ssh', [
		'-i', sshKey, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host,
		`docker exec -i ${container} node --input-type=module`,
	], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
	const stdout = [];
	const stderr = [];
	child.stdout.on('data', (chunk) => stdout.push(chunk));
	child.stderr.on('data', (chunk) => stderr.push(chunk));
	child.stdin.end(remoteScript, 'utf8');
	const exitCode = await Promise.race([
		new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('close', resolve);
		}),
		new Promise((_, reject) => setTimeout(() => {
			child.kill();
			reject(new Error(`Remote command timed out after ${timeoutMs} ms`));
		}, timeoutMs)),
	]);
	const errorText = Buffer.concat(stderr).toString('utf8').trim();
	if (exitCode !== 0) throw new Error(`Remote command failed (${exitCode}): ${errorText.slice(0, 5000)}`);
	const text = Buffer.concat(stdout).toString('utf8').trim();
	return text ? JSON.parse(text) : {};
}

const remoteHelpers = String.raw`
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serializeFilterAttributes } from './packages/backend/dist/catalog-content.js';
import { ErpClient } from './packages/backend/dist/erp/client.js';
import {
	createReceiptDraft, ensureCoreItem, erpContext, erpWarehouse,
	submitDoc, updateCoreCatalogPrices,
} from './packages/backend/dist/erp/operations.js';

const source = ${JSON.stringify(source)};
const sourceHash = '${sourceHash}';
const marker = '${marker}';
const progressPath = '/tmp/${marker}.json';
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sortRows = (rows, fields) => rows.map((row) =>
	Object.fromEntries(fields.map((field) => [field, row[field] ?? null])))
	.sort((a, b) => fields.map((field) => String(a[field] ?? '')).join('\u0000')
		.localeCompare(fields.map((field) => String(b[field] ?? '')).join('\u0000')));
const rowsHash = (rows, fields) => stableHash(sortRows(rows, fields));
const chunks = (values, size = 100) => {
	const output = [];
	for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
	return output;
};
const listForIds = async (doctype, fields, ids, itemField = 'item_code') => {
	const output = [];
	for (const chunk of chunks(ids.map(String), 100)) {
		output.push(...await erp.list(doctype, fields, [[itemField, 'in', chunk]]));
	}
	return output;
};
const selectedRows = (ids) => source.rows.filter((row) => row.kind === 'existing' && ids.includes(String(row.productId)));
const existingIds = [...new Set(source.rows.filter((row) => row.kind === 'existing').map((row) => String(row.productId)))];
const readBins = async (ids) => listForIds('Bin', [
	'name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty',
], ids);
const readPrices = async (ids) => (await listForIds('Item Price', [
	'name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling',
], ids)).filter((row) => ['Standard Selling', 'Standard Buying'].includes(String(row.price_list)));
const referenceSpecs = [
	['Sales Order Item', ['name', 'parent', 'item_code', 'item_name', 'qty', 'rate', 'amount']],
	['Delivery Note Item', ['name', 'parent', 'item_code', 'item_name', 'qty', 'rate', 'amount', 'warehouse']],
	['Stock Entry Detail', ['name', 'parent', 'item_code', 'item_name', 'qty', 'basic_rate', 'amount', 's_warehouse', 't_warehouse']],
	['Purchase Receipt Item', ['name', 'parent', 'item_code', 'item_name', 'qty', 'rate', 'amount', 'warehouse']],
	['Sales Invoice Item', ['name', 'parent', 'item_code', 'item_name', 'qty', 'rate', 'amount']],
];
const readReferences = async (ids, excludeParents = []) => {
	const excluded = new Set(excludeParents.map(String));
	const output = {};
	for (const [doctype, fields] of referenceSpecs) {
		const rows = (await listForIds(doctype, fields, ids)).filter((row) => !excluded.has(String(row.parent ?? '')));
		output[doctype] = { fields, rows: sortRows(rows, fields), hash: rowsHash(rows, fields) };
	}
	return output;
};
const restorePrices = async (ids, before) => {
	const current = await readPrices(ids);
	const beforeByName = new Map(before.map((row) => [String(row.name), row]));
	for (const row of current) {
		if (!beforeByName.has(String(row.name))) await erp.delete('Item Price', String(row.name));
	}
	for (const row of before) {
		await erp.update('Item Price', String(row.name), {
			price_list_rate: Number(row.price_list_rate ?? 0),
			currency: String(row.currency ?? 'RUB'),
		});
	}
};
const removeReceipt = async (name) => {
	const document = await erp.get('Purchase Receipt', name);
	if (!document) return;
	const status = Number(document.docstatus ?? 0);
	if (status === 1) await erp.cancel('Purchase Receipt', name);
	const after = await erp.get('Purchase Receipt', name);
	if (after && Number(after.docstatus ?? 0) !== 1) await erp.delete('Purchase Receipt', name);
};
const sectionFor = (definition) => ({
	'18194': 'Shelly',
	'18172': 'Shelly',
	'18200': 'Shelly',
	'18192': 'Shelly',
	'14226': 'Щиты и Шкафы',
	'13704': 'Кнопки',
	'14800': 'ОПС провод',
	'15680': 'ОПС провод',
	'12394': 'ОПС провод',
	'17130': 'Разъемы',
	'17682': 'Видеонаблюдение',
}[String(definition.analogId ?? '')] ?? 'Прочее оборудование');
const contentFor = (definition, sourceRow) => {
	const productType = String(sourceRow.sourceName || definition.name).trim();
	const summary = productType === definition.name
		? definition.name
		: productType + '. Модель: ' + definition.model + '. Производитель: ' + definition.brand + '.';
	return {
		version: 1,
		summary,
		attributes: [
			{
				id: 'product_type:1', key: 'product_type', label: 'Тип', group: 'Идентификация',
				type: 'option', rawValue: productType, normalizedValue: productType,
				numberValue: null, numberMin: null, numberMax: null, unit: '', booleanValue: null, filterable: true,
			},
		],
	};
};
`;

if (mode === 'snapshot') {
	const remoteScript = `${remoteHelpers}
const ctx = await erpContext(erp);
const requiredWarehouses = ['Shelly', 'Маркетплейс'].map((name) => erpWarehouse(ctx, name));
const warehouses = await erp.list('Warehouse', ['name', 'disabled']);
const missingWarehouses = requiredWarehouses.filter((name) =>
	!warehouses.some((warehouse) => String(warehouse.name) === name && !Number(warehouse.disabled)));
const items = await listForIds('Item', [
	'name', 'item_name', 'disabled', 'is_stock_item', 'stock_uom', 'valuation_rate',
	'b24_model', 'b24_article', 'b24_brand', 'b24_section', 'b24_product_status',
	'description', 'b24_catalog_content', 'b24_filter_category', 'b24_filter_attributes',
	'b24_filter_schema_version', 'b24_filter_updated_at',
], existingIds, 'name');
const missingItems = existingIds.filter((id) => !items.some((item) => String(item.name) === id));
const duplicateCandidates = [];
const bins = await readBins(existingIds);
const prices = await readPrices(existingIds);
const references = await readReferences(existingIds);
const output = {
	version: 1, generatedAt: new Date().toISOString(), sourceHash, marker,
	existingIds, requiredWarehouses, missingWarehouses, missingItems, duplicateCandidates,
	pre: { items, bins, prices, references },
};
process.stdout.write(JSON.stringify(output));
`;
	const snapshot = await runRemote(remoteScript);
	await fs.writeFile(statePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify({
		statePath,
		sourceHash: snapshot.sourceHash,
		existingItems: snapshot.pre?.items?.length,
		missingWarehouses: snapshot.missingWarehouses,
		missingItems: snapshot.missingItems,
		duplicateCandidates: snapshot.duplicateCandidates,
		referenceCounts: Object.fromEntries(Object.entries(snapshot.pre?.references ?? {}).map(([name, value]) => [name, value.rows.length])),
	}, null, 2));
	process.exit(0);
}

const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
if (state.version !== 1 || state.sourceHash !== sourceHash || state.marker !== marker) throw new Error('State/source mismatch');
if (state.missingWarehouses?.length || state.missingItems?.length || state.duplicateCandidates?.length) {
	throw new Error('Snapshot has blocking preflight findings');
}

if (mode === 'attach-products') {
	if (!productsPath) throw new Error('--products is required for attach-products');
	const products = JSON.parse(await fs.readFile(productsPath, 'utf8'));
	const required = source.rows.filter((row) => row.kind === 'new').map((row) => row.sourceId);
	for (const sourceId of required) {
		if (!/^\d+$/.test(String(products[sourceId] ?? ''))) throw new Error(`Missing B24 product id for ${sourceId}`);
	}
	state.b24Products = products;
	state.b24ProductsAttachedAt = new Date().toISOString();
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify({ attached: required.length, statePath }, null, 2));
	process.exit(0);
}

if (mode === 'apply') {
	if (state.apply?.completedAt) throw new Error(`Migration is already applied at ${state.apply.completedAt}`);
	for (const row of source.rows.filter((entry) => entry.kind === 'new')) {
		if (!/^\d+$/.test(String(state.b24Products?.[row.sourceId] ?? ''))) throw new Error(`Missing attached B24 product id for ${row.sourceId}`);
	}
	const remoteScript = `${remoteHelpers}
const snapshot = ${JSON.stringify(state)};
const progress = { marker, sourceHash, startedAt: new Date().toISOString(), createdProducts: [], receipts: [], phase: 'start' };
const saveProgress = async () => fs.writeFile(progressPath, JSON.stringify(progress), 'utf8');
await saveProgress();
const allIds = [...snapshot.existingIds];
try {
	progress.phase = 'create-products';
	await saveProgress();
	for (const row of source.rows.filter((entry) => entry.kind === 'new')) {
		const definition = row.definition;
		const productId = Number(snapshot.b24Products[row.sourceId]);
		if (!(productId > 0)) throw new Error('Missing attached B24 product id for ' + row.sourceId);
		const content = contentFor(definition, row);
		const section = sectionFor(definition);
		await ensureCoreItem(erp, {
			productId, name: definition.name, model: definition.model, article: definition.model,
			brand: definition.brand, section, description: content.summary,
		});
		await erp.update('Item', String(productId), {
			b24_catalog_content: JSON.stringify(content),
			b24_filter_attributes: serializeFilterAttributes(content, section),
			b24_filter_schema_version: '1',
			b24_filter_updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
		});
		row.productId = String(productId);
		progress.createdProducts.push({ sourceId: row.sourceId, productId: String(productId), created: true });
		allIds.push(String(productId));
		await saveProgress();
	}
	progress.phase = 'prices';
	await saveProgress();
	for (const row of source.rows) {
		await updateCoreCatalogPrices(erp, {
			productId: Number(row.productId), retail: Number(row.retail), purchase: Number(row.purchase),
		});
	}
	progress.phase = 'receipts';
	await saveProgress();
	for (const store of ['Shelly', 'Маркетплейс']) {
		const storeRows = source.rows.filter((row) => row.toStore === store);
		const receipt = await createReceiptDraft(erp, {
			lines: storeRows.map((row) => ({
				productId: Number(row.productId), qty: Number(row.quantity), toStore: store, rate: Number(row.purchase),
			})),
			note: marker + ' ' + store,
		});
		progress.receipts.push({ store, name: receipt.name, submitted: false });
		await saveProgress();
		await submitDoc(erp, 'Purchase Receipt', receipt.name);
		progress.receipts[progress.receipts.length - 1].submitted = true;
		await saveProgress();
	}
	progress.phase = 'completed';
	progress.completedAt = new Date().toISOString();
	await saveProgress();
	process.stdout.write(JSON.stringify(progress));
} catch (error) {
	progress.phase = 'failed';
	progress.error = error instanceof Error ? error.message : String(error);
	await saveProgress().catch(() => undefined);
	for (const receipt of [...progress.receipts].reverse()) await removeReceipt(receipt.name).catch(() => undefined);
	await restorePrices(snapshot.existingIds, snapshot.pre.prices).catch(() => undefined);
	for (const product of [...progress.createdProducts].reverse()) {
		if (!product.created) continue;
		await erp.delete('Item', product.productId).catch(() => undefined);
	}
	throw error;
}
`;
	const applied = await runRemote(remoteScript, 1_200_000);
	state.apply = applied;
	state.resolvedRows = source.rows;
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify({
		completedAt: applied.completedAt,
		createdProducts: applied.createdProducts,
		receipts: applied.receipts,
	}, null, 2));
	process.exit(0);
}

if (mode === 'verify') {
	if (!state.apply?.completedAt) throw new Error('Migration has not been applied');
	const remoteScript = `${remoteHelpers}
const snapshot = ${JSON.stringify(state)};
for (const product of snapshot.apply.createdProducts) {
	const row = source.rows.find((entry) => entry.sourceId === product.sourceId);
	if (row) row.productId = product.productId;
}
const allIds = source.rows.map((row) => String(row.productId));
const prices = await readPrices(allIds);
const bins = await readBins(allIds);
const receiptNames = snapshot.apply.receipts.map((receipt) => receipt.name);
const receipts = [];
for (const receipt of snapshot.apply.receipts) {
	const document = await erp.get('Purchase Receipt', receipt.name);
	receipts.push({
		name: receipt.name, store: receipt.store, exists: Boolean(document),
		docstatus: Number(document?.docstatus ?? -1),
		items: (document?.items ?? []).map((item) => ({
			item_code: String(item.item_code), qty: Number(item.qty), rate: Number(item.rate),
			warehouse: String(item.warehouse),
		})),
	});
}
const priceIssues = [];
for (const row of source.rows) {
	const itemPrices = prices.filter((price) => String(price.item_code) === String(row.productId));
	const selling = itemPrices.filter((price) => price.price_list === 'Standard Selling').sort((a, b) => String(b.name).localeCompare(String(a.name)))[0];
	const buying = itemPrices.filter((price) => price.price_list === 'Standard Buying').sort((a, b) => String(b.name).localeCompare(String(a.name)))[0];
	if (Number(selling?.price_list_rate) !== Number(row.retail) || Number(buying?.price_list_rate) !== Number(row.purchase)) {
		priceIssues.push({ sourceId: row.sourceId, productId: row.productId, expected: { retail: row.retail, purchase: row.purchase }, actual: { retail: selling?.price_list_rate, purchase: buying?.price_list_rate } });
	}
}
const ctx = await erpContext(erp);
const stockIssues = [];
for (const row of source.rows) {
	const warehouse = erpWarehouse(ctx, row.toStore);
	const before = snapshot.pre.bins.filter((bin) =>
		String(bin.item_code) === String(row.productId) && String(bin.warehouse) === warehouse)
		.reduce((sum, bin) => sum + Number(bin.actual_qty ?? 0), 0);
	const actual = bins.filter((bin) =>
		String(bin.item_code) === String(row.productId) && String(bin.warehouse) === warehouse)
		.reduce((sum, bin) => sum + Number(bin.actual_qty ?? 0), 0);
	const expected = before + Number(row.quantity);
	if (Math.abs(actual - expected) > 1e-9) stockIssues.push({ sourceId: row.sourceId, productId: row.productId, warehouse, before, added: row.quantity, expected, actual });
}
const receiptIssues = receipts.flatMap((receipt) => {
	const expectedRows = source.rows.filter((row) => row.toStore === receipt.store);
	const issues = [];
	if (!receipt.exists || receipt.docstatus !== 1) issues.push({ name: receipt.name, problem: 'not submitted', docstatus: receipt.docstatus });
	if (receipt.items.length !== expectedRows.length) issues.push({ name: receipt.name, problem: 'line count', expected: expectedRows.length, actual: receipt.items.length });
	for (const row of expectedRows) {
		const item = receipt.items.find((entry) => entry.item_code === String(row.productId));
		if (!item || item.qty !== Number(row.quantity) || item.rate !== Number(row.purchase)) {
			issues.push({ name: receipt.name, sourceId: row.sourceId, productId: row.productId, expected: { qty: row.quantity, rate: row.purchase }, actual: item ?? null });
		}
	}
	return issues;
});
const references = await readReferences(snapshot.existingIds);
const referenceIssues = [];
for (const [doctype, before] of Object.entries(snapshot.pre.references)) {
	const after = references[doctype];
	const originalNames = new Set(before.rows.map((row) => String(row.name)));
	const originalRowsAfter = after.rows.filter((row) => originalNames.has(String(row.name)));
	const originalHashAfter = rowsHash(originalRowsAfter, before.fields);
	if (before.hash !== originalHashAfter || before.rows.length !== originalRowsAfter.length) {
		referenceIssues.push({
			doctype,
			beforeHash: before.hash,
			afterHash: originalHashAfter,
			beforeRows: before.rows.length,
			afterRows: originalRowsAfter.length,
		});
	}
}
const newProductIssues = [];
for (const product of snapshot.apply.createdProducts) {
	const item = await erp.get('Item', product.productId);
	if (!item) newProductIssues.push({ productId: product.productId, erp: false });
}
process.stdout.write(JSON.stringify({
	verifiedAt: new Date().toISOString(), pricesChecked: source.rows.length,
	stocksChecked: source.rows.length, receipts: receipts.map((receipt) => ({ name: receipt.name, store: receipt.store, docstatus: receipt.docstatus, lines: receipt.items.length })),
	priceIssues, stockIssues, receiptIssues, referenceIssues, newProductIssues,
	ok: !priceIssues.length && !stockIssues.length && !receiptIssues.length && !referenceIssues.length && !newProductIssues.length,
}));
`;
	const verification = await runRemote(remoteScript, 1_200_000);
	state.verification = verification;
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify(verification, null, 2));
	process.exit(verification.ok ? 0 : 2);
}

if (mode === 'rollback') {
	if (!state.apply?.completedAt) throw new Error('Migration has not been applied');
	if (state.rollback?.completedAt) throw new Error(`Migration is already rolled back at ${state.rollback.completedAt}`);
	const remoteScript = `${remoteHelpers}
const snapshot = ${JSON.stringify(state)};
for (const receipt of [...snapshot.apply.receipts].reverse()) await removeReceipt(receipt.name);
await restorePrices(snapshot.existingIds, snapshot.pre.prices);
for (const product of [...snapshot.apply.createdProducts].reverse()) {
	if (!product.created) continue;
	await erp.delete('Item', product.productId).catch(() => undefined);
}
process.stdout.write(JSON.stringify({ completedAt: new Date().toISOString(), receipts: snapshot.apply.receipts.map((receipt) => receipt.name), restoredPrices: snapshot.pre.prices.length, deletedProducts: snapshot.apply.createdProducts.filter((product) => product.created).map((product) => product.productId) }));
`;
	const rollback = await runRemote(remoteScript, 1_200_000);
	state.rollback = rollback;
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify(rollback, null, 2));
	process.exit(0);
}

const remoteScript = `${remoteHelpers}
const snapshot = ${JSON.stringify(state)};
const ids = snapshot.existingIds;
const bins = await readBins(ids);
const prices = await readPrices(ids);
const references = await readReferences(ids);
const receiptPresence = [];
for (const receipt of snapshot.apply?.receipts ?? []) receiptPresence.push({ name: receipt.name, exists: Boolean(await erp.get('Purchase Receipt', receipt.name)) });
const newPresence = [];
for (const product of snapshot.apply?.createdProducts ?? []) {
	if (!product.created) continue;
	newPresence.push({
		productId: product.productId,
		erp: Boolean(await erp.get('Item', product.productId)),
	});
}
const referenceIssues = [];
for (const [doctype, before] of Object.entries(snapshot.pre.references)) {
	const after = references[doctype];
	if (before.hash !== after.hash) referenceIssues.push({ doctype, beforeHash: before.hash, afterHash: after.hash });
}
process.stdout.write(JSON.stringify({
	verifiedAt: new Date().toISOString(),
	receiptPresence, newPresence, referenceIssues,
	binsHashMatches: rowsHash(bins, ['name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty']) === rowsHash(snapshot.pre.bins, ['name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty']),
	pricesHashMatches: rowsHash(prices, ['name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling']) === rowsHash(snapshot.pre.prices, ['name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling']),
}));
`;
const verification = await runRemote(remoteScript, 1_200_000);
state.rollbackVerification = verification;
await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(verification, null, 2));
