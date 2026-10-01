import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AccessControlDraft } from '@b24-app/shared';
import { normalizeDomain } from './security.js';

function policyPath(domain: string): string {
	const key = createHash('sha256').update(normalizeDomain(domain)).digest('hex');
	return join(process.env['B24_STATE_DIR'] ?? '/app/state', 'access-control', `${key}.json`);
}

/** Авторитетная политика хранится только на backend; OAuth приложения не даёт её менять напрямую. */
export async function readAccessPolicy(domain: string): Promise<string | undefined> {
	try {
		const raw = await readFile(policyPath(domain), 'utf8');
		const value = JSON.parse(raw) as Partial<AccessControlDraft>;
		if (value.version !== 2 || !Number.isInteger(value.revision) || !value.employees || !value.departments
			|| !['draft', 'active'].includes(String(value.policyMode))) throw new Error('Некорректный файл политики доступа');
		return raw;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

export async function writeAccessPolicy(domain: string, policy: AccessControlDraft): Promise<void> {
	const target = policyPath(domain);
	await mkdir(dirname(target), { recursive: true });
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(policy), { encoding: 'utf8', mode: 0o600 });
		await rename(temporary, target);
	} finally { await rm(temporary, { force: true }); }
}
