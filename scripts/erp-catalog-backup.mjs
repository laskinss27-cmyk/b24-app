import { spawn } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const sshKey = args.get('ssh-key') ?? process.env.B24_SSH_KEY;
const host = args.get('host') ?? process.env.B24_SSH_HOST;
const container = args.get('container') ?? 'erpnext-backend-1';
const site = args.get('site') ?? 'frontend';
if (!sshKey || !host) throw new Error('Required: --ssh-key and --host');
if (!/^[a-zA-Z0-9._-]+$/.test(container) || !/^[a-zA-Z0-9._-]+$/.test(site)) {
	throw new Error('Unsafe container or site name');
}

const remoteScript = `
set -eu
container=${JSON.stringify(container)}
site=${JSON.stringify(site)}
backup_root=/home/frappe/frappe-bench/sites/$site/private/backups
destination=/root/core-backups
mkdir -p "$destination"
docker exec "$container" sh -lc "cd /home/frappe/frappe-bench && bench --site $site backup" >/dev/null
latest="$(docker exec "$container" sh -lc "ls -1t $backup_root/*-database.sql.gz | head -1")"
test -n "$latest"
base="$(basename "$latest")"
docker cp "$container:$latest" "$destination/$base" >/dev/null
bytes="$(wc -c < "$destination/$base" | tr -d ' ')"
hash="$(sha256sum "$destination/$base" | cut -d ' ' -f 1)"
printf '%s\\n%s\\n%s\\n' "$destination/$base" "$bytes" "$hash"
`;

const child = spawn('ssh', [
	'-i', sshKey,
	'-o', 'IdentitiesOnly=yes',
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=15',
	host,
	'bash -s',
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
	throw new Error(Buffer.concat(stderr).toString('utf8').trim() || `Remote backup failed (${exitCode})`);
}
const [backupPath, bytesText, sha256] = Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/u);
const bytes = Number(bytesText);
if (!backupPath?.endsWith('-database.sql.gz') || !Number.isFinite(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/u.test(sha256 ?? '')) {
	throw new Error('Backup verification returned invalid metadata');
}
console.log(JSON.stringify({ backupPath, bytes, sha256 }, null, 2));
