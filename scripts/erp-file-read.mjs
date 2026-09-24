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
const container = args.get('container') ?? 'erpnext-backend-1';
const fileName = args.get('file-name');
const outputPath = path.resolve(args.get('output') ?? '');
if (!sshKey || !host || !fileName || !outputPath) {
	throw new Error('Required: --ssh-key, --host, --file-name and --output');
}
if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) throw new Error('Unsafe file name');
if (!/^[a-zA-Z0-9._-]+$/.test(container)) throw new Error('Unsafe container name');

const remoteScript = `
import base64
from pathlib import Path

file_path = Path('/home/frappe/frappe-bench/sites/frontend/public/files') / ${JSON.stringify(fileName)}
data = file_path.read_bytes()
print(base64.b64encode(data).decode('ascii'))
`;

const child = spawn('ssh', [
	'-i', sshKey,
	'-o', 'IdentitiesOnly=yes',
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=15',
	host,
	`docker exec -i ${container} python -`,
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

const buffer = Buffer.from(Buffer.concat(stdout).toString('ascii').trim(), 'base64');
if (buffer.length === 0) throw new Error('Remote file is empty');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, buffer);
console.log(JSON.stringify({ fileName, outputPath, bytes: buffer.length }, null, 2));
