// Isolated loopback HTTP/CLI smoke. Never calls live CRM or opens the site's database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'packages/backend/src/integrations/umniydom/cli.ts');
const tempRoot = resolve(tmpdir());
const directory = await mkdtemp(join(tempRoot, 'b24-orders-smoke-'));
const payload = await readFile(join(root, 'docs/contracts/order-created.v1.example.json'));
const envelope = JSON.parse(payload.toString('utf8'));
const secret = randomBytes(32).toString('base64url');
const env = { ...process.env, UMNIYDOM_ORDERS_MODE: 'sandbox', UMNIYDOM_ORDERS_PROCESSOR: 'mock',
	UMNIYDOM_ORDERS_SECRET: secret, UMNIYDOM_ORDERS_SOURCE_ID: envelope.sourceId,
	UMNIYDOM_ORDERS_DB: join(directory, 'orders.sqlite'), UMNIYDOM_ORDERS_PORT: '0',
	PORTAL_DOMAIN: 'portal.example.bitrix24.ru', UMNIYDOM_ORDERS_CHAT_ID: 'chat19572',
	UMNIYDOM_ORDERS_CRM_WEBHOOK: '', UMNIYDOM_ORDERS_ROBOT_ID: '', UMNIYDOM_ORDERS_LEAD_STATUS: '',
};
const start = command => spawn(process.execPath, ['--import', 'tsx', cli, command], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
async function run(command) {
	const proc = start(command);
	let output = '';
	proc.stdout.on('data', data => { output += data; });
	proc.stderr.resume();
	const [code] = await once(proc, 'exit');
	assert.equal(code, 0, `CLI ${command} failed`);
	return output;
}
let receiver;
async function serve() {
	receiver = start('serve');
	receiver.stderr.resume();
	return new Promise((resolveAddress, reject) => {
		const timer = setTimeout(() => reject(new Error('Receiver did not start')), 15000);
		let output = '';
		receiver.stdout.on('data', data => {
			output += data;
			const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
			if (address) { clearTimeout(timer); resolveAddress(address); }
		});
		receiver.once('error', error => { clearTimeout(timer); reject(error); });
		receiver.once('exit', () => { clearTimeout(timer); reject(new Error('Receiver stopped')); });
	});
}
async function stop() {
	if (!receiver || receiver.exitCode !== null) return;
	const exited = once(receiver, 'exit'); receiver.kill('SIGTERM'); await exited;
}
const requestHeaders = { authorization: 'Bearer ' + secret, 'content-type': 'application/json',
	'idempotency-key': envelope.eventId, 'x-content-sha256': createHash('sha256').update(payload).digest('hex') };
async function post(address) {
	const response = await fetch(address + '/api/integrations/umniydom/v1/orders', { method: 'POST', redirect: 'error', headers: requestHeaders, body: payload, signal: AbortSignal.timeout(15000) });
	assert.ok([200, 202].includes(response.status)); return response.json();
}
try {
	let address = await serve();
	assert.equal((await fetch(address + '/health')).status, 200);
	const receipts = await Promise.all(Array.from({ length: 20 }, () => post(address)));
	assert.equal(new Set(receipts.map(row => row.receiptId)).size, 1);
	await stop(); address = await serve();
	assert.deepEqual(await post(address), receipts[0]);
	await run('once'); await run('once');
	const rows = JSON.parse(await run('list'));
	assert.equal(rows.length, 1); assert.equal(rows[0].state, 'done'); assert.equal(rows[0].notification_index, 1);
	console.log(JSON.stringify({ ok: true, concurrentRequests: 20, inboxRecords: 1, restartReceiptStable: true, processing: 'done', crm: 'isolated mock', liveWrites: 0 }));
} finally {
	await stop();
	const target = resolve(directory);
	if (!target.startsWith(tempRoot + sep) || !target.slice(tempRoot.length + 1).startsWith('b24-orders-smoke-')) throw new Error('Unsafe cleanup path');
	await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
