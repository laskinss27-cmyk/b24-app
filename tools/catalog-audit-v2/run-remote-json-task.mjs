import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [remoteScriptPath, inputPath, outputPath, taskMode] = process.argv.slice(2);
if (!remoteScriptPath || !inputPath || !outputPath) {
	throw new Error('Usage: node run-remote-json-task.mjs <remote-script> <input-json> <output-json>');
}

const sshKey = process.env.B24_AUDIT_SSH_KEY;
const host = process.env.B24_AUDIT_SSH_HOST;
if (!sshKey || !host) throw new Error('B24_AUDIT_SSH_KEY and B24_AUDIT_SSH_HOST are required');

const [remoteScript, inputText] = await Promise.all([
	fs.readFile(remoteScriptPath, 'utf8'),
	fs.readFile(inputPath, 'utf8'),
]);
const parsedInput = JSON.parse(inputText);
const input = taskMode
	? {
		mode: taskMode,
		groupName: 'товары под заказ',
		expectedCatalogHash: parsedInput.catalog_hash,
		operationId: createHash('sha256').update(inputText).digest('hex').slice(0, 20),
		proposalSummary: parsedInput.summary,
		candidates: (parsedInput.items ?? []).filter((row) => row.status === 'candidate'),
	}
	: parsedInput;
const source = `globalThis.__TASK_INPUT__ = ${JSON.stringify(input)};\n${remoteScript}`;
const child = spawn('ssh', [
	'-i', sshKey,
	'-o', 'IdentitiesOnly=yes',
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=15',
	host,
	'docker exec -i b24-backend node --input-type=module -',
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

const stdout = [];
const stderr = [];
child.stdout.on('data', (chunk) => stdout.push(chunk));
child.stderr.on('data', (chunk) => {
	stderr.push(chunk);
	process.stderr.write(chunk);
});
child.stdin.end(source, 'utf8');
const exitCode = await new Promise((resolve, reject) => {
	child.once('error', reject);
	child.once('close', resolve);
});
if (exitCode !== 0) {
	throw new Error(Buffer.concat(stderr).toString('utf8').trim() || `ssh exited ${exitCode}`);
}
const payload = JSON.parse(Buffer.concat(stdout).toString('utf8'));
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
