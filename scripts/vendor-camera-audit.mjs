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

const vendor = String(args.get('vendor') ?? '').trim();
const sshKey = args.get('ssh-key');
const host = args.get('host');
const container = args.get('container') ?? 'b24-backend';
const outputPath = path.resolve(args.get('output') ?? '');
if (!vendor || !sshKey || !host || !outputPath) {
	throw new Error('Required: --vendor, --ssh-key, --host and --output');
}
if (!/^[a-z0-9 ._-]+$/i.test(vendor)) throw new Error('Vendor must contain ASCII letters only');

const fields = [
	'name',
	'item_code',
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
	'modified',
];
const remoteScript = `
import { ErpClient } from './packages/backend/dist/erp/client.js';
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const vendor = ${JSON.stringify(vendor)};
const fields = ${JSON.stringify(fields)};
const searches = [
	['b24_brand', 'like', '%' + vendor + '%'],
	['item_name', 'like', '%' + vendor + '%'],
	['b24_model', 'like', '%' + vendor + '%'],
];
const byId = new Map();
for (const filter of searches) {
	for (const row of await erp.list('Item', fields, [filter], 0)) byId.set(String(row.name), row);
}
process.stdout.write(JSON.stringify([...byId.values()]));
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
const errorText = Buffer.concat(stderr).toString('utf8').trim();
if (exitCode !== 0) throw new Error(errorText || `Remote command failed (${exitCode})`);

const rawRows = JSON.parse(Buffer.concat(stdout).toString('utf8'));
const isCamera = (row) => {
	const section = String(row.b24_section ?? '').toLowerCase();
	const name = String(row.item_name ?? '').toLowerCase();
	return section.includes('видеокамер')
		|| section.includes('video camera')
		|| section.includes('ip camera')
		|| /^(ip|ahd|hd-tvi|lte|wi-?fi)?[-\s]*видеокамера\b/u.test(name);
};
const parseContent = (value) => {
	try {
		const content = JSON.parse(value || '{}');
		return content && typeof content === 'object' ? content : {};
	} catch {
		return {};
	}
};
const rows = rawRows
	.filter(isCamera)
	.map((row) => {
		const content = parseContent(row.b24_catalog_content);
		const filterContent = parseContent(row.b24_filter_attributes);
		const attributes = Array.isArray(content.attributes) ? content.attributes : [];
		const filters = Array.isArray(filterContent.attributes) ? filterContent.attributes : [];
		return {
			id: String(row.name),
			name: row.item_name ?? '',
			model: row.b24_model ?? '',
			article: row.b24_article ?? '',
			brand: row.b24_brand ?? '',
			section: row.b24_section ?? '',
			status: row.b24_product_status ?? '',
			image: row.image ?? '',
			disabled: Number(row.disabled ?? 0),
			modified: row.modified ?? '',
			attributeCount: attributes.length,
			filterableCount: filters.length || attributes.filter((attribute) => attribute.filterable === true).length,
			attributeKeys: [...new Set(attributes.map((attribute) => String(attribute.key ?? '')).filter(Boolean))],
			shortDescriptionLength: String(content.shortDescription ?? '').trim().length,
			displayDescriptionLength: String(content.displayDescription ?? '').trim().length,
			sourceUrlCount: Array.isArray(content.sourceUrls) ? content.sourceUrls.length : 0,
		};
	})
	.sort((left, right) => left.name.localeCompare(right.name, 'ru'));

const modelGroups = new Map();
for (const row of rows) {
	const modelKey = String(row.model || row.name).trim().toLowerCase();
	if (!modelGroups.has(modelKey)) modelGroups.set(modelKey, []);
	modelGroups.get(modelKey).push(row.id);
}
const imageGroups = new Map();
for (const row of rows.filter((candidate) => candidate.image)) {
	if (!imageGroups.has(row.image)) imageGroups.set(row.image, []);
	imageGroups.get(row.image).push(row);
}
const sharedImageGroups = [...imageGroups.entries()]
	.filter(([, groupedRows]) => groupedRows.length > 1)
	.map(([image, groupedRows]) => ({
		image,
		ids: groupedRows.map((row) => row.id),
		models: [...new Set(groupedRows.map((row) => row.model))],
	}));
const report = {
	version: 1,
	vendor,
	generatedAt: new Date().toISOString(),
	summary: {
		cards: rows.length,
		enabled: rows.filter((row) => row.disabled === 0).length,
		missingImage: rows.filter((row) => !row.image).length,
		thinAttributes: rows.filter((row) => row.attributeCount <= 2).length,
		noFilterableAttributes: rows.filter((row) => row.filterableCount === 0).length,
		missingShortDescription: rows.filter((row) => row.shortDescriptionLength === 0).length,
		missingSourceUrls: rows.filter((row) => row.sourceUrlCount === 0).length,
		brandVariants: Object.fromEntries(Object.entries(Object.groupBy(rows, (row) => row.brand || '(empty)'))
			.map(([key, values]) => [key, values.length])),
		duplicateModelGroups: [...modelGroups.entries()]
			.filter(([, ids]) => ids.length > 1)
			.map(([model, ids]) => ({ model, ids })),
		sharedImageGroups,
	},
	findings: {
		missingImageIds: rows.filter((row) => !row.image).map((row) => row.id),
		thinAttributeIds: rows.filter((row) => row.attributeCount <= 2).map((row) => row.id),
		noFilterableAttributeIds: rows.filter((row) => row.filterableCount === 0).map((row) => row.id),
		missingShortDescriptionIds: rows.filter((row) => row.shortDescriptionLength === 0).map((row) => row.id),
		missingSourceUrlIds: rows.filter((row) => row.sourceUrlCount === 0).map((row) => row.id),
		suspiciousBrandIds: rows
			.filter((row) => /ezviz|hiwatch/i.test(`${row.name} ${row.model}`) || /^cs-/i.test(row.model))
			.map((row) => row.id),
	},
	rows,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
	outputPath,
	...report.summary,
	findings: report.findings,
}, null, 2));
