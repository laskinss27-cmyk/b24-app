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
const outputPath = path.resolve(args.get('output') ?? '');
if (!sshKey || !host || !outputPath) throw new Error('Required: --ssh-key, --host and --output');

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
	'modified',
];
const searches = [
	['b24_section', 'like', '%камер%'],
	['item_name', 'like', '%камер%'],
	['b24_section', 'like', '%регистратор%'],
	['item_name', 'like', '%регистратор%'],
	['item_name', 'like', '%NVR%'],
	['item_name', 'like', '%DVR%'],
	['item_name', 'like', '%XVR%'],
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
if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString('utf8').trim() || `Remote command failed (${exitCode})`);

const raw = JSON.parse(Buffer.concat(stdout).toString('utf8'));
const parseJson = (value) => {
	try {
		const parsed = JSON.parse(String(value ?? '{}'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
};
const classify = (row) => {
	const text = `${row.b24_section ?? ''} ${row.item_name ?? ''}`.toLowerCase();
	if (/регистратор|(?:^|\s)(?:nvr|dvr|xvr)(?:\s|$|-)/iu.test(text)) return 'recorder';
	if (/камер/iu.test(text)) return 'camera';
	return 'other';
};
const rows = raw
	.map((row) => {
		const content = parseJson(row.b24_catalog_content);
		const filters = parseJson(row.b24_filter_attributes);
		return {
			id: Number(row.name),
			name: String(row.item_name ?? ''),
			model: String(row.b24_model ?? ''),
			article: String(row.b24_article ?? ''),
			brand: String(row.b24_brand ?? ''),
			section: String(row.b24_section ?? ''),
			status: String(row.b24_product_status ?? ''),
			kind: classify(row),
			image: String(row.image ?? ''),
			disabled: Number(row.disabled ?? 0),
			modified: String(row.modified ?? ''),
			content,
			filterAttributes: filters,
		};
	})
	.filter((row) => row.kind !== 'other')
	.sort((left, right) => left.kind.localeCompare(right.kind) || left.brand.localeCompare(right.brand, 'ru') || left.name.localeCompare(right.name, 'ru'));

const summary = Object.fromEntries(['camera', 'recorder'].map((kind) => {
	const selected = rows.filter((row) => row.kind === kind);
	const brands = Object.fromEntries([...Map.groupBy(selected, (row) => row.brand || '(empty)').entries()]
		.map(([brand, entries]) => [brand, entries.length])
		.sort((left, right) => right[1] - left[1]));
	return [kind, {
		count: selected.length,
		enabled: selected.filter((row) => row.disabled === 0).length,
		missingImage: selected.filter((row) => !row.image).length,
		missingContent: selected.filter((row) => !Array.isArray(row.content.attributes) || row.content.attributes.length === 0).length,
		brands,
	}];
}));

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), summary, rows }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, summary }, null, 2));
