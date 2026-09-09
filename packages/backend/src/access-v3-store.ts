import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCESS_V3_LIVE_PERMISSIONS, emptyAccessV3Publication, validateAccessV3Rules, emptyAccessV3Pilot, type AccessV3Draft, type AccessV3PilotState, type AccessV3Publication } from '@b24-app/shared';

export interface AccessV3RecordFile { current: AccessV3Draft; history: AccessV3Draft[]; pilot?: AccessV3PilotState; pilotHistory?: AccessV3PilotState[]; publication?: AccessV3Publication; publicationHistory?: AccessV3Publication[] }
export class AccessV3Store {
	constructor(private readonly root = join(process.env['B24_STATE_DIR'] ?? '/app/state', 'access-v3-drafts')) {}
	private path(domain: string): string { return join(this.root, createHash('sha256').update(domain).digest('hex') + '.json'); }
	async read(domain: string): Promise<AccessV3RecordFile | null> {
		let data: string;
		try { data = await readFile(this.path(domain), 'utf8'); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
		const parsed = JSON.parse(data) as AccessV3RecordFile;
		if (parsed.current?.version !== 3 || parsed.current.mode !== 'draft' || !Number.isSafeInteger(parsed.current.revision) || !Array.isArray(parsed.history)) throw new Error('Повреждён черновик прав. Сохранение заблокировано; требуется восстановление.');
		if (parsed.pilot != null) {
			const p = parsed.pilot;
			if (p.version !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 0 || typeof p.active !== 'boolean' || p.userId !== '1858' || p.permissionId !== 'catalog.view_purchase_prices' || (p.active && (p.decision !== 'allow' && p.decision !== 'deny')) || (p.active && (!Number.isSafeInteger(p.draftRevision) || Number(p.draftRevision) < 1))) throw new Error('Повреждена активная версия пилота. Доступ закрыт до восстановления.');
		}
		if (parsed.publication != null) {
			const p = parsed.publication;
			if (p.version !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 0 || typeof p.active !== 'boolean' || (p.active && (!Number.isSafeInteger(p.draftRevision) || Number(p.draftRevision) < 1 || !p.directoryFingerprint))) throw new Error('Повреждена действующая версия прав. Требуется восстановление.');
			for (const rules of [p.departments, p.employees]) {
				if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).some(id => !/^\d{1,12}$/.test(id))) throw new Error('Повреждены правила доступа.');
				validateAccessV3Rules(rules, Object.keys(rules), ACCESS_V3_LIVE_PERMISSIONS);
			}
			if (p.active && parsed.pilot?.active) throw new Error('Одновременно включены несовместимые режимы прав.');
		}
		return parsed;
	}
	async save(domain: string, expectedRevision: number, next: AccessV3Draft, initial?: AccessV3Draft): Promise<AccessV3RecordFile> {
		if (next.mode !== 'draft' || next.version !== 3) throw new Error('В этой версии можно сохранять только черновики прав');
		return this.change(domain, previous => {
			if ((previous?.current.revision ?? 0) !== expectedRevision) throw new Error('Черновик уже изменён. Обновите окно перед сохранением.');
			const current = { ...next, mode: 'draft' as const, revision: expectedRevision + 1 };
			const original = previous?.current ?? initial;
			return { ...previous, current, history: [...(previous?.history ?? []), ...(original ? [original] : [])].slice(-20) };
		});
	}
	async publish(domain: string, compile: (record: AccessV3RecordFile) => AccessV3PilotState): Promise<AccessV3RecordFile> {
		return this.change(domain, previous => {
			if (!previous) throw new Error('Сначала сохраните черновик прав.');
			const old = previous.pilot ?? emptyAccessV3Pilot();
			const pilot = compile(previous);
			if (pilot.active && previous.publication?.active) throw new Error('Рабочие права отделов уже включены; сначала отключите их.');
			return { ...previous, pilot, pilotHistory: [...(previous.pilotHistory ?? []), old].slice(-20) };
		});
	}
	async publishRules(domain: string, compile: (record: AccessV3RecordFile) => AccessV3Publication): Promise<AccessV3RecordFile> {
		return this.change(domain, previous => {
			if (!previous) throw new Error('Сначала сохраните черновик прав.');
			const publication = compile(previous);
			if (publication.active && previous.pilot?.active) throw new Error('Сначала отключите узкий пилот владельца.');
			return { ...previous, publication, publicationHistory: [...(previous.publicationHistory ?? []), previous.publication ?? emptyAccessV3Publication()].slice(-20) };
		});
	}
	private async change(domain: string, update: (previous: AccessV3RecordFile | null) => AccessV3RecordFile): Promise<AccessV3RecordFile> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const file = this.path(domain), lockPath = file + '.lock';
		const lock = await open(lockPath, 'wx', 0o600).catch(error => {
			if (error.code === 'EEXIST') throw new Error('Черновик сейчас сохраняется. Обновите окно и повторите.');
			throw error;
		});
		const temp = file + '.' + randomUUID() + '.tmp';
		try {
			const previous = await this.read(domain);
			const data = update(previous);
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
