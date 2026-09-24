import { spawn } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const names = String(args.get('names') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const sshKey = args.get('ssh-key');
const host = args.get('host');
const container = args.get('container') ?? 'b24-backend';
if (!names.length || !sshKey || !host) throw new Error('Required: --names, --ssh-key and --host');
if (names.some((name) => !/^[a-z0-9]+$/u.test(name))) throw new Error('Invalid File document name');

const remoteScript = `
import { ErpClient } from './packages/backend/dist/erp/client.js';
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const names = ${JSON.stringify(names)};
const deleted = [];
for (const name of names) {
	const file = await erp.get('File', name);
	if (!file) continue;
	const fileName = String(file.file_name ?? '');
	const itemId = String(file.attached_to_name ?? '');
	if (!/^shelly-\\d+-\\d{14}\\.webp$/u.test(fileName)
		|| String(file.attached_to_doctype ?? '') !== 'Item'
		|| !/^\\d+$/u.test(itemId)) {
		throw new Error('Refusing unexpected File ' + name);
	}
	const item = await erp.get('Item', itemId);
	if (!item) throw new Error('Missing attached Item ' + itemId);
	if (String(item.image ?? '') === String(file.file_url ?? '')) {
		throw new Error('Refusing to delete image used by Item ' + itemId);
	}
	await erp.delete('File', name);
	deleted.push({ name, fileName, itemId });
}
process.stdout.write(JSON.stringify({ checked: names.length, deleted }));
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
console.log(Buffer.concat(stdout).toString('utf8').trim());
