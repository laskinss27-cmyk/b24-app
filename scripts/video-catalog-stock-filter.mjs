import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const projectDir = process.cwd();
const sourcePath = path.resolve(
	process.argv[2] ?? path.join(projectDir, 'work-catalog-video-20260728/final-video-catalog.json'),
);
const outputPath = path.resolve(
	process.argv[3] ?? path.join(projectDir, 'work-catalog-video-20260728/unmatched-current-stock.json'),
);
const sshKey = process.env.B24_SSH_KEY ?? 'C:\\Users\\LapTOP\\.ssh\\b24_company';
const host = process.env.B24_SSH_HOST ?? 'root@201.51.12.57';

const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const blocked = Array.isArray(source.blocked) ? source.blocked : [];
const cameras = blocked.filter((row) => row.kind === 'camera');
const recorders = blocked.filter((row) => row.kind === 'recorder');
const cameraIds = cameras.map((row) => String(row.productId));

const remoteScript = `
import { ErpClient } from './packages/backend/dist/erp/client.js';
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const targetIds = new Set(${JSON.stringify(cameraIds)});
const bins = (await erp.list('Bin', ['item_code', 'warehouse', 'actual_qty']))
	.filter((row) => targetIds.has(String(row.item_code ?? '')));
process.stdout.write(JSON.stringify(bins));
`;
const child = spawn('ssh', [
	'-i', sshKey,
	'-o', 'IdentitiesOnly=yes',
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=15',
	host,
	'docker exec -i b24-backend node --input-type=module',
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
const bins = JSON.parse(Buffer.concat(stdout).toString('utf8'));

const totals = new Map(cameraIds.map((id) => [id, 0]));
for (const bin of bins) {
	const id = String(bin.item_code ?? '');
	if (!totals.has(id)) continue;
	const quantity = Number(bin.actual_qty ?? 0);
	totals.set(id, totals.get(id) + (Number.isFinite(quantity) ? quantity : 0));
}

const positiveCameras = [];
const zeroOrNegativeCameras = [];
for (const camera of cameras) {
	const stockTotal = Number(totals.get(String(camera.productId)) ?? 0);
	const row = { ...camera, stockTotal };
	if (stockTotal > 0) positiveCameras.push(row);
	else zeroOrNegativeCameras.push(row);
}

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	sourcePath,
	stockDefinition: 'Sum of Bin.actual_qty across all warehouses; cameras are kept only when total is greater than zero.',
	counts: {
		sourceBlockedCameras: cameras.length,
		keptCameras: positiveCameras.length,
		removedCameras: zeroOrNegativeCameras.length,
		recordersKeptUnfiltered: recorders.length,
		outputRows: positiveCameras.length + recorders.length,
	},
	blocked: [
		...positiveCameras,
		...recorders.map((row) => ({ ...row, stockTotal: null })),
	],
	removedZeroOrNegativeCameras: zeroOrNegativeCameras,
};

await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
	outputPath,
	...result.counts,
}, null, 2)}\n`);
