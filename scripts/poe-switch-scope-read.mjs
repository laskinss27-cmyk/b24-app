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

const sshKey = args.get('ssh-key');
const host = args.get('host');
const container = args.get('container') ?? 'b24-backend';
const outputPath = path.resolve(args.get('output') ?? 'work-catalog-poe-switches/scope.json');
if (!sshKey || !host) throw new Error('Required: --ssh-key and --host');

const fields = [
	'name',
	'item_name',
	'b24_model',
	'b24_article',
	'b24_brand',
	'b24_section',
	'b24_product_status',
	'b24_catalog_content',
	'b24_filter_category',
	'b24_filter_attributes',
	'image',
	'disabled',
	'is_stock_item',
	'modified',
];
const searches = [
	['b24_section', 'like', '%коммутатор%'],
	['item_name', 'like', '%коммутатор%'],
	['b24_section', 'like', '%PoE%'],
	['item_name', 'like', '%PoE%'],
	['item_name', 'like', '%POE%'],
];

const remoteScript = `
import { ErpClient } from './packages/backend/dist/erp/client.js';
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const fields = ${JSON.stringify(fields)};
const searches = ${JSON.stringify(searches)};
const byId = new Map();
for (const filter of searches) {
	for (const row of await erp.list('Item', fields, [filter], 0)) byId.set(String(row.name), row);
}
const ids = [...byId.keys()];
const bins = [];
for (let offset = 0; offset < ids.length; offset += 40) {
	bins.push(...await erp.list('Bin', ['item_code', 'warehouse', 'actual_qty'], [
		['item_code', 'in', ids.slice(offset, offset + 40)],
	], 0));
}
process.stdout.write(JSON.stringify({ items: [...byId.values()], bins }));
`;

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
if (exitCode !== 0) {
	throw new Error(Buffer.concat(stderr).toString('utf8').trim() || `Remote command failed (${exitCode})`);
}

const raw = JSON.parse(Buffer.concat(stdout).toString('utf8'));
const stockById = new Map();
for (const bin of raw.bins ?? []) {
	const id = String(bin.item_code ?? '');
	const quantity = Number(bin.actual_qty ?? 0);
	stockById.set(id, (stockById.get(id) ?? 0) + (Number.isFinite(quantity) ? quantity : 0));
}
const parseJson = (value) => {
	try {
		const parsed = JSON.parse(String(value ?? '{}'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
};
const rows = (raw.items ?? []).map((row) => {
	const text = `${row.b24_section ?? ''} ${row.item_name ?? ''} ${row.b24_model ?? ''}`.toLocaleLowerCase('ru-RU');
	const isSwitch = /коммутатор|ethernet[-\s]*switch|network[-\s]*switch|poe[-\s]*switch/iu.test(text);
	const isPoe = /\bpoe\b|802\.3a[ft]|питани\w*\s+poe/iu.test(text);
	const likelyPoeModel = /(?:^|[-_/])(?:mp(?:e|v\d*)|p(?:e|es)?)(?:$|[-_/])/iu.test(String(row.b24_model ?? ''))
		|| /\d+p(?:e|es)?(?:$|[-_/])/iu.test(String(row.b24_model ?? ''))
		|| /коммутатор.*\d+\s*-\s*\d+\s*вт/iu.test(text);
	const content = parseJson(row.b24_catalog_content);
	return {
		id: Number(row.name),
		name: String(row.item_name ?? ''),
		model: String(row.b24_model ?? ''),
		article: String(row.b24_article ?? ''),
		brand: String(row.b24_brand ?? ''),
		section: String(row.b24_section ?? ''),
		status: String(row.b24_product_status ?? ''),
		image: String(row.image ?? ''),
		disabled: Number(row.disabled ?? 0),
		isStockItem: Number(row.is_stock_item ?? 0),
		modified: String(row.modified ?? ''),
		stockTotal: Number(stockById.get(String(row.name)) ?? 0),
		isCandidate: Number(row.is_stock_item ?? 0) === 1
			&& Number.isInteger(Number(row.name))
			&& isSwitch
			&& (isPoe || likelyPoeModel),
		content,
		filterAttributes: parseJson(row.b24_filter_attributes),
	};
}).sort((left, right) => (
	Number(right.isCandidate) - Number(left.isCandidate)
	|| right.stockTotal - left.stockTotal
	|| left.brand.localeCompare(right.brand, 'ru')
	|| left.name.localeCompare(right.name, 'ru')
));

const candidates = rows.filter((row) => row.isCandidate);
const summary = {
	matchedBySearch: rows.length,
	candidates: candidates.length,
	enabled: candidates.filter((row) => row.disabled === 0).length,
	positiveStock: candidates.filter((row) => row.stockTotal > 0).length,
	zeroOrNegativeStock: candidates.filter((row) => row.stockTotal <= 0).length,
	missingImage: candidates.filter((row) => !row.image).length,
	missingContent: candidates.filter((row) => !Array.isArray(row.content.attributes) || !row.content.attributes.length).length,
	brands: Object.fromEntries([...Map.groupBy(candidates, (row) => row.brand || '(empty)').entries()]
		.map(([brand, entries]) => [brand, entries.length])
		.sort((left, right) => right[1] - left[1])),
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({
	version: 1,
	generatedAt: new Date().toISOString(),
	summary,
	rows,
}, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, summary }, null, 2));
