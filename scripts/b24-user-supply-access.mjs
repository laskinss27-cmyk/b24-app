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

const mode = args.get('mode');
const userId = String(args.get('user-id') ?? '');
const expectedName = String(args.get('expected-name') ?? '').trim();
const departmentId = Number(args.get('department-id') ?? '10');
const statePath = path.resolve(args.get('state') ?? 'local-artifacts/b24-user-supply-access.json');
const envPath = path.resolve(args.get('env-file') ?? '.env');
const sshKey = args.get('ssh-key') ?? process.env.B24_SSH_KEY;
const host = args.get('host') ?? process.env.B24_SSH_HOST;
const container = args.get('container') ?? 'b24-backend';

if (!new Set(['snapshot', 'apply', 'verify', 'rollback']).has(mode ?? '')) throw new Error('Unknown --mode');
if (!/^\d{1,12}$/u.test(userId) || !Number.isInteger(departmentId) || departmentId <= 0) {
	throw new Error('Invalid user or department ID');
}
if (!expectedName || !sshKey || !host) throw new Error('Required: --expected-name, --ssh-key and --host');
if (!/^[a-zA-Z0-9._-]+$/u.test(container)) throw new Error('Unsafe container name');

const envText = await fs.readFile(envPath, 'utf8');
const envValues = Object.fromEntries(envText
	.split(/\r?\n/u)
	.map((line) => line.trim())
	.filter((line) => line && !line.startsWith('#') && line.includes('='))
	.map((line) => {
		const separator = line.indexOf('=');
		const key = line.slice(0, separator).trim();
		const rawValue = line.slice(separator + 1).trim();
		const value = /^(['"]).*\1$/u.test(rawValue) ? rawValue.slice(1, -1) : rawValue;
		return [key, value];
	}));
const webhook = String(process.env.DEV_WEBHOOK ?? envValues.DEV_WEBHOOK ?? '').trim();
if (!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+\/?$/u.test(webhook)) {
	throw new Error('A valid DEV_WEBHOOK is required in the local environment file');
}

const normalizedName = (value) => String(value ?? '')
	.toLocaleLowerCase('ru-RU')
	.replace(/ё/gu, 'е')
	.replace(/[^a-zа-я0-9]+/giu, ' ')
	.trim()
	.split(/\s+/u)
	.filter(Boolean)
	.sort()
	.join(' ');

async function runRemote(body) {
	const remoteBody = { ...body, webhook };
	const remoteScript = `
import { B24Client } from './packages/backend/dist/b24/client.js';
const body = ${JSON.stringify(remoteBody)};
const client = new B24Client({ auth: { kind: 'webhook', url: body.webhook } });
const readUser = async () => {
	const rows = await client.call('user.get', { FILTER: { ID: body.userId } });
	const user = Array.isArray(rows) ? rows.find((row) => String(row.ID ?? '') === body.userId) : null;
	if (!user) throw new Error('Bitrix24 user not found: ' + body.userId);
	return {
		id: String(user.ID ?? ''),
		name: String(user.NAME ?? ''),
		lastName: String(user.LAST_NAME ?? ''),
		active: String(user.ACTIVE ?? ''),
		position: String(user.WORK_POSITION ?? ''),
		departments: [...new Set((Array.isArray(user.UF_DEPARTMENT) ? user.UF_DEPARTMENT : [user.UF_DEPARTMENT])
			.map(Number).filter(Number.isFinite))].sort((a, b) => a - b),
	};
};
if (body.action === 'read') {
	const user = await readUser();
	process.stdout.write(JSON.stringify({ user }));
} else if (body.action === 'update') {
	const before = await readUser();
	const result = await client.call('user.update', { ID: body.userId, UF_DEPARTMENT: body.departments });
	const after = await readUser();
	process.stdout.write(JSON.stringify({ result, before, after }));
} else {
	throw new Error('Unknown remote action');
}
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
	const output = Buffer.concat(stdout).toString('utf8').trim();
	return output ? JSON.parse(output) : {};
}

const displayName = (user) => `${user?.lastName ?? ''} ${user?.name ?? ''}`.trim();
const assertIdentity = (user) => {
	if (String(user?.id ?? '') !== userId) throw new Error('Unexpected user ID');
	if (normalizedName(displayName(user)) !== normalizedName(expectedName)) {
		throw new Error(`User name mismatch: expected "${expectedName}", got "${displayName(user)}"`);
	}
	if (!new Set(['Y', 'TRUE', '1']).has(String(user?.active ?? '').toUpperCase())) {
		throw new Error('User is not active');
	}
};

if (mode === 'snapshot') {
	const snapshot = await runRemote({ action: 'read', userId, departmentId });
	assertIdentity(snapshot.user);
	const state = {
		version: 1,
		generatedAt: new Date().toISOString(),
		userId,
		expectedName,
		departmentId,
		before: snapshot.user,
		apply: null,
	};
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
	console.log(JSON.stringify({
		mode,
		statePath,
		user: snapshot.user,
		alreadyMember: snapshot.user.departments.includes(departmentId),
	}, null, 2));
} else {
	const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
	if (state.version !== 1 || state.userId !== userId || state.departmentId !== departmentId) {
		throw new Error('Invalid state file');
	}
	assertIdentity(state.before);
	const beforeDepartments = [...new Set(state.before.departments.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
	if (mode === 'apply') {
		if (state.apply?.completedAt) throw new Error(`Already applied at ${state.apply.completedAt}`);
		const departments = [...new Set([...beforeDepartments, departmentId])].sort((a, b) => a - b);
		const result = await runRemote({ action: 'update', userId, departmentId, departments });
		assertIdentity(result.after);
		const valid = JSON.stringify(result.before.departments) === JSON.stringify(beforeDepartments)
			&& departments.every((id) => result.after.departments.includes(id))
			&& result.after.departments.length === departments.length;
		if (!valid) {
			await runRemote({ action: 'update', userId, departmentId, departments: beforeDepartments });
			throw new Error('Read-back mismatch; original departments restored');
		}
		state.apply = {
			completedAt: new Date().toISOString(),
			departments,
			result: result.result,
		};
		await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
		console.log(JSON.stringify({ mode, user: result.after, addedDepartment: departmentId, changed: !beforeDepartments.includes(departmentId) }, null, 2));
	} else if (mode === 'verify') {
		if (!state.apply?.completedAt) throw new Error('No completed apply in state');
		const current = await runRemote({ action: 'read', userId, departmentId });
		assertIdentity(current.user);
		const expectedDepartments = state.apply.departments;
		const safe = JSON.stringify(current.user.departments) === JSON.stringify(expectedDepartments)
			&& current.user.departments.includes(departmentId);
		console.log(JSON.stringify({ mode, safe, user: current.user }, null, 2));
		if (!safe) process.exitCode = 1;
	} else {
		const result = await runRemote({ action: 'update', userId, departmentId, departments: beforeDepartments });
		assertIdentity(result.after);
		const safe = JSON.stringify(result.after.departments) === JSON.stringify(beforeDepartments);
		state.rollback = { completedAt: new Date().toISOString(), safe };
		await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
		console.log(JSON.stringify({ mode, safe, user: result.after }, null, 2));
		if (!safe) process.exitCode = 1;
	}
}
