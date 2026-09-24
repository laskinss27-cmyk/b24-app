import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const [remoteScriptPath, outputPath, ...remoteArgs] = process.argv.slice(2);
if (!remoteScriptPath || !outputPath) {
	throw new Error('Usage: node run-remote-readonly.mjs <remote-script> <output-json> [remote-args...]');
}

const sshKey = process.env.B24_AUDIT_SSH_KEY;
const host = process.env.B24_AUDIT_SSH_HOST;
if (!sshKey || !host) throw new Error('B24_AUDIT_SSH_KEY and B24_AUDIT_SSH_HOST are required');

const remoteScript = await fs.readFile(remoteScriptPath, 'utf8');
const remoteCommand = ['docker', 'exec', '-i', 'b24-backend', 'node', '--input-type=module', '-', ...remoteArgs].join(' ');
const child = spawn('ssh', [
	'-i', sshKey,
	'-o', 'IdentitiesOnly=yes',
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=15',
	host,
	remoteCommand,
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
if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString('utf8').trim() || `ssh exited ${exitCode}`);

const payload = JSON.parse(Buffer.concat(stdout).toString('utf8'));
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
	outputPath: path.resolve(outputPath),
	generatedAt: payload.generatedAt,
	catalogHash: payload.catalogHash,
	summary: payload.summary,
}, null, 2)}\n`);
