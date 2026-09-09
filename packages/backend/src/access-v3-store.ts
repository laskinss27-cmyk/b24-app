import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccessV3Draft } from '@b24-app/shared';

interface RecordFile { current: AccessV3Draft; history: AccessV3Draft[] }
export class AccessV3Store {
	constructor(private readonly root = join(process.env['B24_STATE_DIR'] ?? '/app/state', 'access-v3-drafts')) {}
	private path(domain: string): string { return join(this.root, createHash('sha256').update(domain).digest('hex') + '.json'); }
	async read(domain: string): Promise<RecordFile | null> {
		let data: string;
		try { data = await readFile(this.path(domain), 'utf8'); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
		const parsed = JSON.parse(data) as RecordFile;
		if (parsed.current?.version !== 3 || parsed.current.mode !== 'draft' || !Number.isSafeInteger(parsed.current.revision) || !Array.isArray(parsed.history)) throw new Error('Повреждён черновик прав. Сохранение заблокировано; требуется восстановление.');
		return parsed;
	}
	async save(domain: string, expectedRevision: number, next: AccessV3Draft, initial?: AccessV3Draft): Promise<RecordFile> {
		if (next.mode !== 'draft' || next.version !== 3) throw new Error('В этой версии можно сохранять только черновики прав');
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const file = this.path(domain), lockPath = file + '.lock';
		const lock = await open(lockPath, 'wx', 0o600).catch(error => {
			if (error.code === 'EEXIST') throw new Error('Черновик сейчас сохраняется. Обновите окно и повторите.');
			throw error;
		});
		const temp = file + '.' + randomUUID() + '.tmp';
		try {
			const previous = await this.read(domain);
			if ((previous?.current.revision ?? 0) !== expectedRevision) throw new Error('Черновик уже изменён. Обновите окно перед сохранением.');
			const current = { ...next, mode: 'draft' as const, revision: expectedRevision + 1 };
			const original = previous?.current ?? initial;
			const data = { current, history: [...(previous?.history ?? []), ...(original ? [original] : [])].slice(-20) };
			const handle = await open(temp, 'wx', 0o600);
			try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
			await rename(temp, file);
			return data;
		} finally {
			try { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
			finally { await lock.close(); await unlink(lockPath); }
		}
	}
}
