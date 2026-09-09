import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { accessV3Permissions, previewAccessV3, validateAccessV3Rules, type AccessV3Directory, type AccessV3Draft } from '@b24-app/shared';
import type { B24Client } from '../b24/client.js';
import { accessClientFrom, ACCESS_MANAGER_IDS } from '../access-policy.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { listActiveStoreTitles } from '../erp/operations.js';
import { AccessV3Store } from '../access-v3-store.js';
import { seedAccessV3 } from '../access-v3-baseline.js';

export async function readAccessV3Rows(client: B24Client, method: string, params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = []; const seen = new Set<string>(); let start = 0;
	for (let page = 0; page < 1000; page++) {
		const result = await client.callWithMeta<Array<Record<string, unknown>>>(method, { ...params, start });
		if (!Array.isArray(result.result)) throw new Error('Битрикс не вернул полный справочник сотрудников/отделов');
		for (const row of result.result) {
			const id = String(row.ID ?? '');
			if (!/^\d{1,12}$/.test(id) || seen.has(id)) throw new Error('Битрикс вернул неполный или повторяющийся справочник');
			seen.add(id);rows.push(row);
		}
		if (result.next == null) {
			if (result.total != null && Number(result.total) !== rows.length) throw new Error('Справочник Битрикса прочитан не полностью. Обновите окно.');
			return rows;
		}
		if (!result.result.length || !Number.isInteger(Number(result.next)) || Number(result.next) <= start) throw new Error('Не удалось прочитать следующую страницу справочника Битрикса');
		start = Number(result.next);
	}
	throw new Error('Справочник слишком большой; чтение остановлено без сохранения');
}

export async function readAccessV3Directory(client: B24Client): Promise<AccessV3Directory> {
	const erp = ErpClient.fromEnv();if (!erp) throw new Error('ERP недоступна: нельзя подтвердить список складов');
	const [users, departments, stores] = await Promise.all([
		readAccessV3Rows(client, 'user.get', { FILTER: { ACTIVE: true }, SORT: 'ID', ORDER: 'ASC' }),
		readAccessV3Rows(client, 'department.get', {}), listActiveStoreTitles(erp),
	]);
	const result = {
		users: users.map(u => ({ id: String(u.ID), name: `${u.LAST_NAME ?? ''} ${u.NAME ?? ''}`.trim() || `#${u.ID}`, firstName: String(u.NAME ?? ''), lastName: String(u.LAST_NAME ?? ''), position: String(u.WORK_POSITION ?? ''),
			departments: [...new Set((Array.isArray(u.UF_DEPARTMENT) ? u.UF_DEPARTMENT : [u.UF_DEPARTMENT]).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b) })).sort((a, b) => a.id.localeCompare(b.id)),
		departments: departments.map(d => ({ id: Number(d.ID), name: String(d.NAME ?? `Отдел #${d.ID}`) })).sort((a, b) => a.id - b.id),
		stores: [...new Set(stores)].sort(),
	};
	if (result.users.some(u => u.departments.some(id => !result.departments.some(d => d.id === id)))) throw new Error('Не все отделы сотрудников доступны. Нельзя строить права по неполному справочнику.');
	return { ...result, fingerprint: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

/** Draft editor only. It is deliberately not imported by access-policy or business routes. */
export function registerAccessV3Routes(app: FastifyInstance, store = new AccessV3Store(), directoryReader = readAccessV3Directory): void {
	for (const action of ['load', 'preview', 'save'] as const) app.post(`/api/access-control/v3/${action}`, async (req, reply) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const auth = { domain: String(body.domain ?? ''), accessToken: String(body.accessToken ?? '') };
		const client = accessClientFrom(app, auth);
		if (!client) return reply.code(403).send({ ok: false, error: 'Откройте настройки из приложения Битрикс24.' });
		try {
			const actor = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; ADMIN?: unknown }>('user.current', {});
			const actorId = String(actor?.ID ?? '');
			if (!/^\d{1,12}$/.test(actorId) || (!ACCESS_MANAGER_IDS.has(actorId) && actor.ADMIN !== true && String(actor.ADMIN ?? '').toUpperCase() !== 'Y')) {
				return reply.code(403).send({ ok: false, error: 'Черновики прав доступны только руководству и администраторам. Личный переключатель не даёт доступ к этому редактору.' });
			}
			const domain = normalizeDomain(auth.domain);
			const [directory, saved] = await Promise.all([directoryReader(client), store.read(domain)]);
			const current = saved?.current ?? seedAccessV3(directory);
			const history = (saved?.history ?? []).map(d => ({ revision: d.revision, updatedAt: d.updatedAt, updatedBy: d.updatedBy }));
			if (action === 'load') return { ok: true, draft: current, directory, history, enforcement: false };
			if (Number(body.revision) !== current.revision || body.directoryFingerprint !== directory.fingerprint) {
				return reply.code(409).send({ ok: false, error: 'Изменился черновик или список сотрудников/складов. Обновите окно и заново проверьте изменения.' });
			}
			const incoming = body.restoreRevision == null ? body.rules as Partial<AccessV3Draft> | undefined
				: saved?.history.find(d => d.revision === Number(body.restoreRevision));
			if (!incoming) throw new Error('Версия черновика или набор правил не найдены');
			const keys = accessV3Permissions(directory.stores).map(p => p.id);
			const next: AccessV3Draft = { ...current, mode: 'draft',
				departments: validateAccessV3Rules(incoming.departments, directory.departments.map(d => String(d.id)), keys),
				employees: validateAccessV3Rules(incoming.employees, directory.users.map(u => u.id), keys),
			};
			const preview = previewAccessV3(current, next, directory);
			const token = createHash('sha256').update(JSON.stringify(canonical({ revision: current.revision, fingerprint: directory.fingerprint, departments: next.departments, employees: next.employees }))).digest('hex');
			if (action === 'preview') return { ok: true, ...preview, token, enforcement: false };
			if (body.previewToken !== token) return reply.code(409).send({ ok: false, error: 'Сначала проверьте актуальные изменения. Предыдущий просмотр больше не подходит.' });
			if (JSON.stringify(next).length > 2_000_000) throw new Error('Черновик слишком большой');
			next.updatedAt = new Date().toISOString();next.updatedBy = `${actor.LAST_NAME ?? ''} ${actor.NAME ?? ''}`.trim() || `#${actorId}`;
			const result = await store.save(domain, current.revision, next, current);
			app.log.info({ actorId, revision: result.current.revision, restoredFrom: body.restoreRevision ?? null, changedRules: preview.changedRules, affectedUsers: preview.changedUsers }, '[access-v3] draft saved; enforcement remains off');
			return { ok: true, draft: result.current, directory, history: result.history.map(d => ({ revision: d.revision, updatedAt: d.updatedAt, updatedBy: d.updatedBy })), enforcement: false };
		} catch (error) {
			app.log.warn({ action, error: error instanceof Error ? error.message : 'unknown' }, '[access-v3] failed closed');
			return reply.code(409).send({ ok: false, error: error instanceof Error ? error.message : 'Не удалось проверить права. Изменения не сохранены.' });
		}
	});
}
