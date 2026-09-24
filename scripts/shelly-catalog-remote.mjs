import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
const resultPath = path.resolve(args.get('result') ?? '');
const progressPath = path.resolve(args.get('progress') ?? '');
if (!['apply', 'audit', 'verify', 'rollback'].includes(mode ?? '')) throw new Error('Unknown --mode');
if (!sourcePath || !statePath || !resultPath || !progressPath) {
	throw new Error('Required: --source, --state, --result and --progress');
}

const clientModule = path.join(process.cwd(), 'packages/backend/dist/erp/client.js');
const { ErpClient } = await import(pathToFileURL(clientModule).href);
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');

const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizeRows = (rows, fields) => rows
	.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])))
	.sort((a, b) => fields.map((field) => String(a[field] ?? '')).join('\u0000')
		.localeCompare(fields.map((field) => String(b[field] ?? '')).join('\u0000')));
const rowsHash = (rows, fields) => stableHash(normalizeRows(rows, fields));
const same = (left, right) => String(left ?? '') === String(right ?? '');
const writeJson = async (filePath, value) => fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
if (!Array.isArray(source.products) || source.products.length !== 130 || state.targetCount !== 130) {
	throw new Error('Expected exactly 130 products and a matching snapshot');
}
if (state.sourceHash !== stableHash(source)) throw new Error('Source changed after snapshot');
const excludedIds = new Set(['18414', '18416', '18418', '18574']);
const targets = [];
const ids = new Set();
for (const product of source.products) {
	const id = String(product.productId ?? '');
	if (!/^\d+$/.test(id) || ids.has(id) || excludedIds.has(id)) throw new Error(`Invalid product ID ${id}`);
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
	const imagePath = path.join(path.dirname(sourcePath), 'images', path.basename(product.image.localPath));
	const image = await fs.readFile(imagePath);
	const imageHash = createHash('sha256').update(image).digest('hex');
	if (imageHash !== product.image.sha256 || image.length !== Number(product.image.bytes)) {
		throw new Error(`Image integrity mismatch for ${id}`);
	}
	targets.push({
		id,
		description: String(product.displayDescription).trim().slice(0, 10_000).replaceAll('&', '&amp;'),
		category: String(product.categoryKey),
		contentString: JSON.stringify(content),
		filterAttributesString: JSON.stringify(filterAttributes),
		image,
	});
	ids.add(id);
}

const mutableFields = state.mutableFields;
const immutableFields = state.immutableFields;
const beforeById = Object.fromEntries(state.snapshot.items.map((row) => [String(row.name), row]));
const readItems = async (fields) => {
	const rows = [];
	const allIds = [...ids];
	for (let offset = 0; offset < allIds.length; offset += 8) {
		rows.push(...(await Promise.all(allIds.slice(offset, offset + 8)
			.map((id) => erp.get('Item', id)))).filter(Boolean));
	}
	return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])));
};
const listForIds = async (doctype, fields, idField) => {
	const rows = [];
	const allIds = [...ids];
	for (let offset = 0; offset < allIds.length; offset += 40) {
		rows.push(...await erp.list(doctype, fields, [[idField, 'in', allIds.slice(offset, offset + 40)]], 0));
	}
	return rows;
};

if (mode === 'audit') {
	const expectedById = Object.fromEntries(targets.map((row) => [row.id, row]));
	const items = await readItems([...new Set([...mutableFields, 'name'])]);
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
			&& String(item.image ?? '').includes(`shelly-${id}-`);
		if (isUnchanged) unchanged.push(id);
		else if (isApplied) applied.push(id);
		else partial.push({
			id,
			changedFields: mutableFields.filter((field) => !same(item[field], before[field])),
			image: String(item.image ?? ''),
		});
	}
	const audit = { checked: items.length, unchanged, applied, partial };
	await writeJson(resultPath, audit);
	console.log(JSON.stringify(audit));
	process.exit(0);
}

if (mode === 'apply') {
	try {
		await fs.access(resultPath);
		throw new Error(`Result already exists: ${resultPath}`);
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
	}
	const updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
	const runSuffix = new Date().toISOString().replace(/\D/gu, '').slice(0, 14);
	const progress = {
		version: 1,
		startedAt: new Date().toISOString(),
		updatedAt,
		runSuffix,
		phase: 'apply',
		touched: [],
		completed: [],
		createdFiles: [],
	};
	await writeJson(progressPath, progress);
	const restore = async () => {
		progress.phase = 'rollback';
		await writeJson(progressPath, progress);
		const rollbackErrors = [];
		for (const id of [...progress.touched].reverse()) {
			const before = beforeById[id];
			try {
				await erp.update('Item', id, Object.fromEntries(mutableFields.map((field) => [field, before[field] ?? ''])));
			} catch (error) {
				rollbackErrors.push(`Item ${id}: ${String(error?.message ?? error)}`);
			}
		}
		for (const file of [...progress.createdFiles].reverse()) {
			try {
				await erp.delete('File', file.name);
			} catch (error) {
				rollbackErrors.push(`File ${file.name}: ${String(error?.message ?? error)}`);
			}
		}
		return rollbackErrors;
	};
	const applyOne = async (row) => {
		const before = beforeById[row.id];
		const current = await erp.get('Item', row.id);
		if (!current) throw new Error(`Missing Item ${row.id}`);
		for (const field of mutableFields) {
			if (!same(current[field], before[field])) throw new Error(`Precondition mismatch ${row.id} field ${field}`);
		}
		await erp.update('Item', row.id, {
			description: row.description,
			b24_catalog_content: row.contentString,
			b24_filter_category: row.category,
			b24_filter_attributes: row.filterAttributesString,
			b24_filter_schema_version: '1',
			b24_filter_updated_at: updatedAt,
		});
		progress.touched.push(row.id);
		const file = await erp.create('File', {
			file_name: `shelly-${row.id}-${runSuffix}.webp`,
			content: row.image.toString('base64'),
			decode: 1,
			is_private: 0,
			attached_to_doctype: 'Item',
			attached_to_name: row.id,
		});
		if (!file.name || !file.file_url) throw new Error(`File upload did not return URL for ${row.id}`);
		progress.createdFiles.push({ id: row.id, name: String(file.name), fileUrl: String(file.file_url) });
		await erp.update('Item', row.id, { image: file.file_url });
		const actual = await erp.get('Item', row.id);
		for (const [field, expected] of Object.entries({
			description: row.description,
			b24_catalog_content: row.contentString,
			b24_filter_category: row.category,
			b24_filter_attributes: row.filterAttributesString,
			b24_filter_schema_version: '1',
			b24_filter_updated_at: updatedAt,
			image: file.file_url,
		})) {
			if (!same(actual?.[field], expected)) throw new Error(`Read-back mismatch ${row.id} field ${field}`);
		}
		progress.completed.push(row.id);
	};
	try {
		for (let offset = 0; offset < targets.length; offset += 4) {
			const settled = await Promise.allSettled(targets.slice(offset, offset + 4).map(applyOne));
			await writeJson(progressPath, progress);
			const failure = settled.find((result) => result.status === 'rejected');
			if (failure) throw failure.reason;
		}
		progress.phase = 'completed';
		progress.completedAt = new Date().toISOString();
		await writeJson(progressPath, progress);
		const result = {
			completedAt: progress.completedAt,
			updatedAt,
			completed: progress.completed.length,
			createdFiles: progress.createdFiles,
			rolledBack: false,
		};
		await writeJson(resultPath, result);
		console.log(JSON.stringify(result));
	} catch (error) {
		const rollbackErrors = await restore();
		const result = {
			failedAt: new Date().toISOString(),
			completed: progress.completed.length,
			touched: progress.touched.length,
			createdFiles: progress.createdFiles.length,
			rolledBack: true,
			rollbackErrors,
			error: String(error?.message ?? error),
		};
		await writeJson(resultPath, result);
		await writeJson(progressPath, { ...progress, phase: 'failed', result });
		console.error(JSON.stringify(result));
		process.exitCode = 1;
	}
	process.exit();
}

const applyResult = JSON.parse(await fs.readFile(resultPath, 'utf8'));
if (mode === 'rollback') {
	if (applyResult.rolledBack || !Array.isArray(applyResult.createdFiles)) throw new Error('No completed apply result');
	const fileErrors = [];
	for (const [id, before] of Object.entries(beforeById)) {
		await erp.update('Item', id, Object.fromEntries(mutableFields.map((field) => [field, before[field] ?? ''])));
	}
	for (const file of [...applyResult.createdFiles].reverse()) {
		try {
			await erp.delete('File', file.name);
		} catch (error) {
			fileErrors.push({ name: file.name, error: String(error?.message ?? error) });
		}
	}
	const rollbackResult = { restored: 130, deletedFiles: applyResult.createdFiles.length - fileErrors.length, fileErrors };
	await writeJson(progressPath, { phase: 'rollback-completed', ...rollbackResult });
	console.log(JSON.stringify(rollbackResult));
	process.exit(fileErrors.length ? 1 : 0);
}

if (applyResult.rolledBack || applyResult.completed !== 130) throw new Error('Apply result is not complete');
const expectedById = Object.fromEntries(targets.map((row) => {
	const file = applyResult.createdFiles.find((entry) => entry.id === row.id);
	return [row.id, {
		description: row.description,
		b24_catalog_content: row.contentString,
		b24_filter_category: row.category,
		b24_filter_attributes: row.filterAttributesString,
		b24_filter_schema_version: '1',
		b24_filter_updated_at: applyResult.updatedAt,
		image: file?.fileUrl ?? '',
	}];
}));
const items = await readItems([...new Set([...mutableFields, ...immutableFields])]);
const byId = new Map(items.map((row) => [String(row.name), row]));
const mismatches = [];
for (const id of ids) {
	const actual = byId.get(id);
	const expected = expectedById[id];
	const reasons = [];
	if (!actual) reasons.push('missing');
	for (const field of mutableFields) {
		if (!same(actual?.[field], expected?.[field])) reasons.push(field);
	}
	if (reasons.length) mismatches.push({ id, reasons });
}
const binFields = ['name', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'planned_qty'];
const priceFields = ['name', 'item_code', 'price_list', 'price_list_rate', 'currency', 'buying', 'selling'];
const bins = await listForIds('Bin', binFields, 'item_code');
const prices = await listForIds('Item Price', priceFields, 'item_code');
const verification = {
	checked: items.length,
	mismatches,
	immutableHash: rowsHash(items, immutableFields),
	bins: { count: bins.length, hash: rowsHash(bins, binFields) },
	prices: { count: prices.length, hash: rowsHash(prices, priceFields) },
};
verification.safe = verification.checked === 130
	&& verification.mismatches.length === 0
	&& verification.immutableHash === state.snapshot.immutableHash
	&& verification.bins.count === state.snapshot.bins.count
	&& verification.bins.hash === state.snapshot.bins.hash
	&& verification.prices.count === state.snapshot.prices.count
	&& verification.prices.hash === state.snapshot.prices.hash;
await writeJson(progressPath, { phase: 'verified', ...verification });
console.log(JSON.stringify(verification));
if (!verification.safe) process.exitCode = 1;
