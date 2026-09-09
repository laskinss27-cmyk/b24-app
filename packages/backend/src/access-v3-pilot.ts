import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { APP_OWNER_USER_ID, emptyAccessV3Pilot, resolveAccessV3Override, type AccessV3PilotPreview, type AccessV3PilotState, type AccessV3Person } from '@b24-app/shared';
import { accessClientFrom, ACCESS_MANAGER_IDS } from './access-policy.js';
import { AccessV3Store, type AccessV3RecordFile } from './access-v3-store.js';
import { ACCESS_V3_SHADOW_ROUTES, bounded } from './access-v3-shadow.js';
import { normalizeDomain } from './security.js';

export function previewAccessV3Pilot(record: AccessV3RecordFile, user: AccessV3Person): AccessV3PilotPreview {
	if (user.id !== APP_OWNER_USER_ID) throw new Error('Пилот доступен только владельцу #1858.');
	const rule = resolveAccessV3Override(record.current, user, 'catalog.view_purchase_prices', []);
	if (!rule || rule.value === 'context') throw new Error('Для владельца задайте явное разрешение или запрет «Каталог → Видеть закупочные цены» и сохраните черновик.');
	if (rule.conflict) throw new Error('Сначала устраните конфликт правил отделов.');
	const proposal = { pilotRevision: record.pilot?.revision ?? 0, draftRevision: record.current.revision, decision: rule.value, source: rule.source, userId: '1858' as const, permissionId: 'catalog.view_purchase_prices' as const };
	return { ...proposal, token: createHash('sha256').update(JSON.stringify({ ...proposal, departments: [...user.departments].sort((a,b)=>a-b) })).digest('hex') };
}

function actorDepartments(raw: unknown): number[] {
	if (!Array.isArray(raw) || raw.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw new Error('Не подтверждён состав отделов владельца.');
	return [...new Set(raw.map(Number))];
}

/** A separate immutable publication, never the currently edited draft. */
export function registerAccessV3Pilot(app: FastifyInstance, store = new AccessV3Store()): void {
	app.decorateRequest('accessV3Pilot', null);
	app.addHook('preHandler', async (req, reply) => {
		if (!(ACCESS_V3_SHADOW_ROUTES as readonly string[]).includes(String(req.routeOptions.url ?? ''))) return;
		// The existing authenticated actor may safely exclude a non-participant. Missing identity must not bypass an active denial.
		if (req.appAccess?.user.id && req.appAccess.user.id !== APP_OWNER_USER_ID) return;
		try {
			const record = await store.read(normalizeDomain(app.config.portalDomain));
			if (!record?.pilot?.active) return;
			const body = (req.body ?? {}) as Record<string, unknown>;
			const client = accessClientFrom(app, { domain: String(body.domain ?? ''), accessToken: String(body.accessToken ?? '') });
			if (!client) return reply.code(403).send({ ok: false, error: 'Для проверки доступа к закупочным ценам нужна действующая сессия Битрикс24.' });
			const actor = await bounded(client.call<{ ID?: unknown }>('user.current', {}), 5000);
			if (!/^\d{1,12}$/.test(String(actor.ID ?? ''))) throw new Error('Не подтверждён пользователь');
			if (String(actor.ID) === APP_OWNER_USER_ID) req.accessV3Pilot = record.pilot;
		} catch {
			return reply.code(503).send({ ok: false, error: 'Не удалось безопасно проверить активный пилот прав. Повторите запрос или отключите пилот в конфигураторе.' });
		}
	});
	for (const action of ['status', 'preview', 'activate', 'disable'] as const) app.post(`/api/access-control/v3/pilot/${action}`, async (req, reply) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const client = accessClientFrom(app, { domain: String(body.domain ?? ''), accessToken: String(body.accessToken ?? '') });
		if (!client) return reply.code(403).send({ ok: false, error: 'Нужна действующая сессия Битрикс24.' });
		try {
			const actor = await client.call<{ ID?: unknown; UF_DEPARTMENT?: unknown; ADMIN?: unknown }>('user.current', {});
			const id = String(actor.ID ?? '');
			if (id !== APP_OWNER_USER_ID && (action !== 'status' || (!ACCESS_MANAGER_IDS.has(id) && actor.ADMIN !== true && actor.ADMIN !== 'Y'))) return reply.code(403).send({ ok: false, error: 'Включать и отключать пилот может только владелец #1858.' });
			const domain = normalizeDomain(app.config.portalDomain), record = await store.read(domain);
			const result = (value: AccessV3RecordFile | null) => ({ ok: true, state: value?.pilot ?? emptyAccessV3Pilot(), history: value?.pilotHistory ?? [], canActivate: id === APP_OWNER_USER_ID });
			if (action === 'status') return result(record);
			if (!record) throw new Error('Сначала сохраните черновик прав.');
			if (action === 'disable') return result(await store.publish(domain, latest => ({ ...emptyAccessV3Pilot(), revision: (latest.pilot?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), updatedById: id })));
			const user = { id, name: '', departments: actorDepartments(actor.UF_DEPARTMENT) };
			if (action === 'preview') return { ok: true, ...previewAccessV3Pilot(record, user) };
			return result(await store.publish(domain, latest => {
				const preview = previewAccessV3Pilot(latest, user);
				if (body.previewToken !== preview.token || body.draftRevision !== preview.draftRevision || body.pilotRevision !== preview.pilotRevision) throw new Error('Черновик или активная версия изменились. Заново проверьте включение.');
				return { ...emptyAccessV3Pilot(), active: true, decision: preview.decision, draftRevision: preview.draftRevision, revision: preview.pilotRevision + 1, updatedAt: new Date().toISOString(), updatedById: id };
			}));
		} catch (error) { return reply.code(409).send({ ok: false, error: error instanceof Error ? error.message : 'Не удалось изменить пилот.' }); }
	});
}

declare module 'fastify' { interface FastifyRequest { accessV3Pilot: AccessV3PilotState | null } }
