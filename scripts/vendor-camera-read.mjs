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

const ids = String(args.get('ids') ?? '')
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean);
const sshKey = args.get('ssh-key');
const host = args.get('host');
const container = args.get('container') ?? 'b24-backend';
const imageDir = args.get('image-dir');
if (!ids.length || ids.some((id) => !/^\d+$/.test(id)) || !sshKey || !host) {
	throw new Error('Required: --ids, --ssh-key and --host');
}

const fields = [
	'name',
	'item_code',
	'item_name',
	'b24_model',
	'b24_article',
	'b24_brand',
	'b24_section',
	'b24_product_status',
	'description',
	'b24_catalog_content',
	'b24_filter_category',
	'b24_filter_attributes',
	'image',
	'modified',
];

const remoteScript = `
import { ErpClient } from './packages/backend/dist/erp/client.js';
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const ids = ${JSON.stringify(ids)};
const fields = ${JSON.stringify(fields)};
const rows = [];
for (const id of ids) {
	const item = await erp.get('Item', id);
	const row = Object.fromEntries(fields.map((field) => [field, item?.[field] ?? null]));
	if (${JSON.stringify(Boolean(imageDir))} && row.image) {
		const response = await fetch(new URL(row.image, process.env.ERPNEXT_URL));
		if (!response.ok) throw new Error('Image read failed for ' + id + ': HTTP ' + response.status);
		row.imageBytes = Buffer.from(await response.arrayBuffer()).toString('base64');
		row.imageContentType = response.headers.get('content-type');
	}
	rows.push(row);
}
process.stdout.write(JSON.stringify(rows));
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
const rows = JSON.parse(Buffer.concat(stdout).toString('utf8'));
if (imageDir) {
	await fs.mkdir(imageDir, { recursive: true });
	for (const row of rows) {
		if (!row.imageBytes) continue;
		const extension = path.extname(new URL(row.image, 'https://erp.invalid').pathname) || '.bin';
		await fs.writeFile(path.join(imageDir, `${row.name}${extension}`), Buffer.from(row.imageBytes, 'base64'));
		delete row.imageBytes;
	}
}
process.stdout.write(`${JSON.stringify(imageDir
	? rows.map((row) => ({
		name: row.name,
		item_name: row.item_name,
		brand: row.b24_brand,
		image: row.image,
		imageContentType: row.imageContentType,
		attributes: (() => {
			try {
				return JSON.parse(row.b24_catalog_content || '{}').attributes?.length ?? 0;
			} catch {
				return -1;
			}
		})(),
		filterable: (() => {
			try {
				return JSON.parse(row.b24_filter_attributes || '{}').attributes?.length ?? 0;
			} catch {
				return -1;
			}
		})(),
	}))
	: rows, null, 2)}\n`);
