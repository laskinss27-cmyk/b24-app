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
const expectedCount = Number(args.get('expected-count') ?? '130');
const allowedModes = new Set(['snapshot', 'audit', 'apply', 'verify', 'rollback', 'verify-rollback']);
if (!allowedModes.has(mode ?? '')) throw new Error('Unknown --mode');
if (!sourcePath || !statePath || !sshKey || !host) {
	throw new Error('Required: --source, --state, --ssh-key and --host');
}
if (!Number.isInteger(expectedCount) || expectedCount <= 0) throw new Error('Invalid --expected-count');

const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escapeHtml = (value) => String(value)
	.replaceAll('&', '&amp;')
	.replaceAll('<', '&lt;')
	.replaceAll('>', '&gt;');
const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
if (!Array.isArray(source.products) || source.products.length !== expectedCount) {
	throw new Error(`Expected exactly ${expectedCount} products, got ${source.products?.length ?? 0}`);
}
const vendorKey = String(source.vendorKey ?? 'shelly').trim().toLowerCase();
if (!/^[a-z0-9-]+$/.test(vendorKey)) throw new Error('Invalid source vendorKey');

const excludedIds = new Set(['18414', '18416', '18418', '18574']);
const allowedBrandCorrections = new Map([
	['14248', 'EZVIZ'],
	['16094', 'EZVIZ'],
	['19798', 'Hikvision'],
	['18108', 'iFLOW'],
	['19328', 'TP-Link'],
]);
const allowedIdentityCorrections = new Map([
	['13076', {
		itemName: 'IP-видеорегистратор RL-NVR64C-4H',
		model: 'RL-NVR64C-4H',
	}],
	['18098', {
		itemName: '18-портовый неуправляемый PoE-коммутатор RL-SW16P2S2.ZE',
		model: 'RL-SW16P2S2.ZE',
	}],
	['12060', {
		itemName: 'Монтажная коробка на 2 камеры со встроенным PoE-коммутатором RL-POE.BOX',
		model: 'RL-POE.BOX',
	}],
]);
const ids = new Set();
const targets = [];
for (const product of source.products) {
	const id = String(product.productId ?? '');
	if (!/^\d+$/.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate product ID ${id}`);
	if (excludedIds.has(id)) throw new Error(`Excluded product unexpectedly present: ${id}`);
	if (!product.shortDescription || !product.displayDescription || !product.categoryKey) {
		throw new Error(`Incomplete catalog content for ${id}`);
	}
	if (!Array.isArray(product.attributes) || !product.attributes.length) {
		throw new Error(`No attributes for ${id}`);
	}
	const keepExistingImage = product.keepExistingImage === true;
	if (!keepExistingImage && (!product.image?.localPath || !product.image?.sha256 || product.image?.format !== 'webp')) {
		throw new Error(`Incomplete image metadata for ${id}; use keepExistingImage only intentionally`);
	}
	let image = null;
	if (!keepExistingImage) {
		const imagePath = path.resolve(path.dirname(sourcePath), path.basename(product.image.localPath));
		const fallbackImagePath = path.resolve(product.image.localPath);
		let resolvedImagePath = imagePath;
		try {
			await fs.access(resolvedImagePath);
		} catch {
			resolvedImagePath = fallbackImagePath;
		}
		const imageBuffer = await fs.readFile(resolvedImagePath);
		const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
		if (imageHash !== product.image.sha256 || imageBuffer.length !== Number(product.image.bytes)) {
			throw new Error(`Image integrity mismatch for ${id}`);
		}
		image = {
			fileName: `${vendorKey}-${id}.webp`,
			bytes: imageBuffer.length,
			sha256: imageHash,
			base64: mode === 'apply' ? imageBuffer.toString('base64') : '',
		};
	}
	const brandCorrection = product.brandCorrection == null ? null : String(product.brandCorrection).trim();
	if (brandCorrection && allowedBrandCorrections.get(id) !== brandCorrection) {
		throw new Error(`Brand correction is not allowed for ${id}: ${brandCorrection}`);
	}
	const allowedIdentity = allowedIdentityCorrections.get(id);
	const requestedItemName = String(product.currentName ?? '').trim();
	const requestedModel = String(product.model ?? '').trim();
	const itemNameCorrection = allowedIdentity && requestedItemName === allowedIdentity.itemName
		? requestedItemName
		: null;
	const modelCorrection = allowedIdentity && requestedModel === allowedIdentity.model
		? requestedModel
		: null;
	if (allowedIdentity && (!itemNameCorrection || !modelCorrection)) {
		throw new Error(`Incomplete approved identity correction for ${id}`);
	}
	const content = {
		version: 1,
		summary: String(product.shortDescription).trim().slice(0, 4_000),
		attributes: product.attributes.map((attribute, index) => ({
			id: `${attribute.key}:${Number(attribute.order ?? index + 1)}`,
			key: String(attribute.key),
			label: String(attribute.label),
			group: String(attribute.group || 'Дополнительно'),
			type: String(attribute.type),
			rawValue: String(attribute.rawValue),
			normalizedValue: String(attribute.normalizedValue ?? attribute.rawValue),
			numberValue: attribute.numberValue ?? null,
			numberMin: attribute.numberMin ?? null,
			numberMax: attribute.numberMax ?? null,
			unit: String(attribute.unit ?? ''),
			booleanValue: typeof attribute.booleanValue === 'boolean' ? attribute.booleanValue : null,
			filterable: attribute.filterable === true,
		})),
	};
	const filterAttributes = {
		version: 1,
		category: String(product.categoryKey),
		attributes: content.attributes.filter((attribute) => attribute.filterable).map((attribute) => ({
			key: attribute.key,
			label: attribute.label,
			type: attribute.type,
			value: attribute.normalizedValue,
			raw: attribute.rawValue,
			number: attribute.numberValue,
			min: attribute.numberMin,
			max: attribute.numberMax,
			unit: attribute.unit,
			boolean: attribute.booleanValue,
		})),
	};
	targets.push({
		id,
		description: escapeHtml(String(product.displayDescription).trim().slice(0, 10_000)),
		category: String(product.categoryKey),
		contentString: JSON.stringify(content),
		filterAttributesString: JSON.stringify(filterAttributes),
		brandCorrection,
		itemNameCorrection,
		modelCorrection,
		image,
	});
	ids.add(id);
}

const sourceHash = stableHash(source);
const payloadHash = stableHash(targets.map((row) => ({
	...row,
	image: row.image ? { ...row.image, base64: '' } : null,
})));
const hasBrandCorrections = targets.some((row) => Boolean(row.brandCorrection));
const hasIdentityCorrections = targets.some((row) => Boolean(row.itemNameCorrection || row.modelCorrection));
const mutableFields = [
	'description',
	'b24_catalog_content',
	'b24_filter_category',
	'b24_filter_attributes',
	'b24_filter_schema_version',
	'b24_filter_updated_at',
	'image',
	...(hasBrandCorrections ? ['b24_brand'] : []),
	...(hasIdentityCorrections ? ['item_name', 'b24_model'] : []),
];
const immutableFields = [
	'name',
	'disabled',
	'is_stock_item',
	'stock_uom',
	'valuation_rate',
	...(!hasIdentityCorrections ? ['item_name', 'b24_model'] : []),
	'b24_article',
	...(!hasBrandCorrections ? ['b24_brand'] : []),
	'b24_section',
	'b24_product_status',
];

async function runRemote(remoteScript, captureFailure = false) {
	const child = spawn('ssh', [
		'-i', sshKey,
		'-o', 'IdentitiesOnly=yes',
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
	const output = Buffer.concat(stdout).toString('utf8').trim();
	if (exitCode !== 0) {
		if (captureFailure && output) {
			return { ...JSON.parse(output), remoteExitCode: exitCode, remoteError: errorText };
		}
		throw new Error(`Remote command failed (${exitCode}): ${errorText.slice(0, 5_000)}`);
	}
	return output ? JSON.parse(output) : {};
}

const remoteHelpers = String.raw`
import { createHash } from 'node:crypto';
import { ErpClient } from './packages/backend/dist/erp/client.js';
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizeRows = (rows, fields) => rows
	.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])))
	.sort((a, b) => fields.map((field) => String(a[field] ?? '')).join('\u0000')
		.localeCompare(fields.map((field) => String(b[field] ?? '')).join('\u0000')));
const rowsHash = (rows, fields) => stableHash(normalizeRows(rows, fields));
const listForIds = async (doctype, fields, ids, idField) => {
	const rows = [];
	for (let offset = 0; offset < ids.length; offset += 40) {
		const chunk = ids.slice(offset, offset + 40);
		rows.push(...await erp.list(doctype, fields, [[idField, 'in', chunk]], 0));
	}
	return rows;
};
const readItems = async (ids, fields) => {
	const rows = [];
	for (let offset = 0; offset < ids.length; offset += 8) {
		rows.push(...(await Promise.all(ids.slice(offset, offset + 8)
			.map((id) => erp.get('Item', id)))).filter(Boolean));
	}
	return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])));
};
`;

if (mode === 'snapshot') {
	const remoteScript = `${remoteHelpers}
const targets = ${JSON.stringify(targets.map((row) => ({ ...row, image: { ...row.image, base64: '' } })))};
const ids = targets.map((row) => row.id);
const mutableFields = ${JSON.stringify(mutableFields)};
const immutableFields = ${JSON.stringify(immutableFields)};
const customFieldNames = [
	'Item-b24_catalog_content',
	'Item-b24_filter_category',
	'Item-b24_filter_attributes',
	'Item-b24_filter_schema_version',
	'Item-b24_filter_updated_at',
];
const customFields = (await Promise.all(customFieldNames.map((name) => erp.get('Custom Field', name)))).filter(Boolean);
const items = await readItems(ids, [...new Set([...mutableFields, ...immutableFields])]);
const foundIds = new Set(items.map((row) => String(row.name)));
const missing = ids.filter((id) => !foundIds.has(id));
const bins = await listForIds('Bin', [
	'name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty',
], ids, 'item_code');
const prices = await listForIds('Item Price', [
	'name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling',
], ids, 'item_code');
const binFields = ['name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty'];
const priceFields = ['name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling'];
process.stdout.write(JSON.stringify({
	generatedAt: new Date().toISOString(),
	customFieldNames,
	foundCustomFieldNames: customFields.map((row) => String(row.name)),
	items,
	missing,
	immutableHash: rowsHash(items, immutableFields),
	bins: { count: bins.length, hash: rowsHash(bins, binFields) },
	prices: { count: prices.length, hash: rowsHash(prices, priceFields) },
}));
`;
	const snapshot = await runRemote(remoteScript);
	const missingFields = snapshot.customFieldNames.filter((name) => !snapshot.foundCustomFieldNames.includes(name));
	const state = {
		version: 1,
		generatedAt: new Date().toISOString(),
		sourcePath,
		sourceHash,
		payloadHash,
		targetCount: targets.length,
		mutableFields,
		immutableFields,
		snapshot,
	};
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify({
		mode,
		statePath,
		targets: targets.length,
		items: snapshot.items.length,
		missing: snapshot.missing,
		missingFields,
		bins: snapshot.bins.count,
		prices: snapshot.prices.count,
	}, null, 2));
	if (snapshot.missing.length || missingFields.length || snapshot.items.length !== expectedCount) process.exitCode = 1;
} else {
	const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
	if (state.version !== 1 || state.targetCount !== expectedCount) throw new Error('Invalid snapshot state');
	if (state.sourceHash !== sourceHash || state.payloadHash !== payloadHash) {
		throw new Error('Source package changed after snapshot');
	}
	if (state.snapshot.missing.length || state.snapshot.items.length !== expectedCount) {
		throw new Error('Snapshot contains blocking findings');
	}
	const beforeById = Object.fromEntries(state.snapshot.items.map((row) => [String(row.name), row]));

	if (mode === 'audit') {
		const expectedById = Object.fromEntries(targets.map((row) => [row.id, row]));
		const remoteScript = `${remoteHelpers}
const ids = ${JSON.stringify([...ids])};
const expectedById = ${JSON.stringify(expectedById)};
const beforeById = ${JSON.stringify(beforeById)};
const mutableFields = ${JSON.stringify(mutableFields)};
const vendorKey = ${JSON.stringify(vendorKey)};
const items = await readItems(ids, [...new Set([...mutableFields, 'name'])]);
const same = (left, right) => String(left ?? '') === String(right ?? '');
const unchanged = [];
const applied = [];
const partial = [];
for (const item of items) {
	const id = String(item.name);
	const before = beforeById[id];
	const expected = expectedById[id];
	const isUnchanged = mutableFields.every((field) => same(item[field], before[field]));
	const isApplied = same(item.description, expected.description)
		&& same(item.b24_catalog_content, expected.contentString)
		&& same(item.b24_filter_category, expected.category)
		&& same(item.b24_filter_attributes, expected.filterAttributesString)
		&& same(item.b24_filter_schema_version, '1')
		&& Boolean(item.b24_filter_updated_at)
		&& same(item.b24_brand, expected.brandCorrection ?? before.b24_brand)
		&& same(item.item_name, expected.itemNameCorrection ?? before.item_name)
		&& same(item.b24_model, expected.modelCorrection ?? before.b24_model)
		&& (expected.image
			? String(item.image ?? '').includes(vendorKey + '-' + id + '-')
			: same(item.image, before.image));
	if (isUnchanged) unchanged.push(id);
	else if (isApplied) applied.push(id);
	else partial.push({
		id,
		changedFields: mutableFields.filter((field) => !same(item[field], before[field])),
		image: String(item.image ?? ''),
	});
}
const files = await listForIds('File', [
	'name', 'file_name', 'file_url', 'attached_to_doctype', 'attached_to_name',
], ids, 'attached_to_name');
const uploadFiles = files.filter((file) => String(file.file_name ?? '').startsWith(vendorKey + '-')
	&& String(file.attached_to_doctype ?? '') === 'Item');
process.stdout.write(JSON.stringify({
	checked: items.length,
	unchanged,
	applied,
	partial,
	uploadFiles: uploadFiles.map((file) => ({
		name: file.name,
		fileName: file.file_name,
		fileUrl: file.file_url,
		item: file.attached_to_name,
	})),
}));
`;
		const result = await runRemote(remoteScript);
		console.log(JSON.stringify({
			mode,
			checked: result.checked,
			unchanged: result.unchanged.length,
			applied: result.applied.length,
			partial: result.partial,
			uploadFiles: result.uploadFiles.length,
			uploadFileDetails: result.uploadFiles,
			appliedIds: result.applied,
		}, null, 2));
	} else if (mode === 'apply') {
		if (state.apply?.completedAt) throw new Error(`Upload already completed at ${state.apply.completedAt}`);
		const updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
		const runSuffix = new Date().toISOString().replace(/\D/gu, '').slice(0, 14);
		const applyTargets = targets.map((row) => ({
			...row,
			updatedAt,
			image: row.image ? { ...row.image, fileName: `${vendorKey}-${row.id}-${runSuffix}.webp` } : null,
		}));
		const remoteScript = `${remoteHelpers}
const targets = ${JSON.stringify(applyTargets)};
const beforeById = ${JSON.stringify(beforeById)};
const mutableFields = ${JSON.stringify(mutableFields)};
const touched = [];
const createdFiles = [];
const completed = [];
const same = (left, right) => String(left ?? '') === String(right ?? '');
const restore = async () => {
	const errors = [];
	for (const id of [...touched].reverse()) {
		const before = beforeById[id];
		try {
			await erp.update('Item', id, Object.fromEntries(mutableFields.map((field) => [field, before[field] ?? ''])));
		} catch (error) {
			errors.push('Item ' + id + ': ' + String(error?.message ?? error));
		}
	}
	for (const file of [...createdFiles].reverse()) {
		try {
			await erp.delete('File', file.name);
		} catch (error) {
			errors.push('File ' + file.name + ': ' + String(error?.message ?? error));
		}
	}
	return errors;
};
try {
	const applyOne = async (row) => {
		const before = beforeById[row.id];
		const current = await erp.get('Item', row.id);
		if (!current) throw new Error('Missing Item ' + row.id);
		for (const field of mutableFields) {
			if (!same(current[field], before[field])) throw new Error('Precondition mismatch ' + row.id + ' field ' + field);
		}
		await erp.update('Item', row.id, {
			description: row.description,
			b24_catalog_content: row.contentString,
			b24_filter_category: row.category,
			b24_filter_attributes: row.filterAttributesString,
			b24_filter_schema_version: '1',
			b24_filter_updated_at: row.updatedAt,
			...(row.brandCorrection ? { b24_brand: row.brandCorrection } : {}),
			...(row.itemNameCorrection ? { item_name: row.itemNameCorrection } : {}),
			...(row.modelCorrection ? { b24_model: row.modelCorrection } : {}),
		});
		touched.push(row.id);
		let file = null;
		if (row.image) {
			file = await erp.create('File', {
				file_name: row.image.fileName,
				content: row.image.base64,
				decode: 1,
				is_private: 0,
				attached_to_doctype: 'Item',
				attached_to_name: row.id,
			});
			if (!file.name || !file.file_url) throw new Error('File upload did not return URL for ' + row.id);
			createdFiles.push({ id: row.id, name: String(file.name), fileUrl: String(file.file_url) });
			await erp.update('Item', row.id, { image: file.file_url });
		}
		const actual = await erp.get('Item', row.id);
		for (const [field, expected] of Object.entries({
			description: row.description,
			b24_catalog_content: row.contentString,
			b24_filter_category: row.category,
			b24_filter_attributes: row.filterAttributesString,
			b24_filter_schema_version: '1',
			b24_filter_updated_at: row.updatedAt,
			image: file?.file_url ?? before.image,
			b24_brand: row.brandCorrection ?? before.b24_brand,
			item_name: row.itemNameCorrection ?? before.item_name,
			b24_model: row.modelCorrection ?? before.b24_model,
		})) {
			if (!same(actual?.[field], expected)) throw new Error('Read-back mismatch ' + row.id + ' field ' + field);
		}
		completed.push(row.id);
	};
	for (let offset = 0; offset < targets.length; offset += 4) {
		const settled = await Promise.allSettled(targets.slice(offset, offset + 4).map(applyOne));
		const failure = settled.find((result) => result.status === 'rejected');
		if (failure) throw failure.reason;
	}
	process.stdout.write(JSON.stringify({
		completedAt: new Date().toISOString(),
		updatedAt: ${JSON.stringify(updatedAt)},
		completed: completed.length,
		createdFiles,
		rolledBack: false,
	}));
} catch (error) {
	const rollbackErrors = await restore();
	process.stdout.write(JSON.stringify({
		completed: completed.length,
		touched: touched.length,
		createdFiles: createdFiles.length,
		rolledBack: true,
		rollbackErrors,
		error: String(error?.message ?? error),
	}));
	process.exitCode = 1;
}
`;
		const result = await runRemote(remoteScript, true);
		state.apply = result;
		await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
		console.log(JSON.stringify({ mode, targets: targets.length, ...result }, null, 2));
		if (result.remoteExitCode || result.rolledBack) process.exitCode = 1;
	} else if (mode === 'rollback') {
		if (!state.apply?.createdFiles?.length) throw new Error('No completed upload recorded in state');
		const remoteScript = `${remoteHelpers}
const beforeById = ${JSON.stringify(beforeById)};
const mutableFields = ${JSON.stringify(mutableFields)};
const createdFiles = ${JSON.stringify(state.apply.createdFiles)};
const restored = [];
const fileErrors = [];
for (const [id, before] of Object.entries(beforeById)) {
	await erp.update('Item', id, Object.fromEntries(mutableFields.map((field) => [field, before[field] ?? ''])));
	restored.push(id);
}
for (const file of [...createdFiles].reverse()) {
	try {
		await erp.delete('File', file.name);
	} catch (error) {
		fileErrors.push({ name: file.name, error: String(error?.message ?? error) });
	}
}
process.stdout.write(JSON.stringify({ restored: restored.length, deletedFiles: createdFiles.length - fileErrors.length, fileErrors }));
`;
		const result = await runRemote(remoteScript);
		state.rollback = { ...result, completedAt: new Date().toISOString() };
		await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
		console.log(JSON.stringify({ mode, ...result }, null, 2));
		if (result.fileErrors.length) process.exitCode = 1;
	} else {
		const verifyRollback = mode === 'verify-rollback';
		if (!verifyRollback && (!state.apply?.completedAt || state.apply?.rolledBack)) {
			throw new Error('No completed upload recorded in state');
		}
		const expectedById = verifyRollback
			? beforeById
			: Object.fromEntries(targets.map((row) => {
				const file = state.apply.createdFiles.find((entry) => entry.id === row.id);
				return [row.id, {
					description: row.description,
					b24_catalog_content: row.contentString,
					b24_filter_category: row.category,
					b24_filter_attributes: row.filterAttributesString,
					b24_filter_schema_version: '1',
					b24_filter_updated_at: state.apply.updatedAt,
					image: file?.fileUrl ?? beforeById[row.id].image ?? '',
					b24_brand: row.brandCorrection ?? beforeById[row.id].b24_brand ?? '',
					item_name: row.itemNameCorrection ?? beforeById[row.id].item_name ?? '',
					b24_model: row.modelCorrection ?? beforeById[row.id].b24_model ?? '',
				}];
			}));
		const remoteScript = `${remoteHelpers}
const ids = ${JSON.stringify([...ids])};
const expectedById = ${JSON.stringify(expectedById)};
const mutableFields = ${JSON.stringify(mutableFields)};
const immutableFields = ${JSON.stringify(immutableFields)};
const items = await readItems(ids, [...new Set([...mutableFields, ...immutableFields])]);
const byId = new Map(items.map((row) => [String(row.name), row]));
const mismatches = [];
for (const id of ids) {
	const actual = byId.get(id);
	const expected = expectedById[id];
	const reasons = [];
	if (!actual) reasons.push('missing');
	for (const field of mutableFields) {
		if (String(actual?.[field] ?? '') !== String(expected?.[field] ?? '')) reasons.push(field);
	}
	if (reasons.length) mismatches.push({ id, reasons });
}
const bins = await listForIds('Bin', [
	'name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty',
], ids, 'item_code');
const prices = await listForIds('Item Price', [
	'name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling',
], ids, 'item_code');
const binFields = ['name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty'];
const priceFields = ['name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling'];
const result = {
	checked: items.length,
	mismatches,
	immutableHash: rowsHash(items, immutableFields),
	bins: { count: bins.length, hash: rowsHash(bins, binFields) },
	prices: { count: prices.length, hash: rowsHash(prices, priceFields) },
};
process.stdout.write(JSON.stringify(result));
`;
		const result = await runRemote(remoteScript);
		const safe = result.checked === expectedCount
			&& result.mismatches.length === 0
			&& result.immutableHash === state.snapshot.immutableHash
			&& result.bins.count === state.snapshot.bins.count
			&& result.bins.hash === state.snapshot.bins.hash
			&& result.prices.count === state.snapshot.prices.count
			&& result.prices.hash === state.snapshot.prices.hash;
		console.log(JSON.stringify({ mode, safe, ...result }, null, 2));
		if (!safe) process.exitCode = 1;
	}
}
