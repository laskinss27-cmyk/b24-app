import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ACCESS_V3_LIVE_PERMISSIONS, APP_OWNER_USER_ID, emptyAccessV3Publication, resolveAccessV3Override, validateAccessV3Rules, type AccessV3Directory, type AccessV3Publication, type AccessV3PublicationPreview, type AccessV3Rules } from '@b24-app/shared';
import { accessClientFrom, ACCESS_MANAGER_IDS } from './access-policy.js';
import { AccessV3Store, type AccessV3RecordFile } from './access-v3-store.js';
import { bounded } from './access-v3-shadow.js';
import { readAccessV3Directory } from './routes/api-access-v3.js';
import { normalizeDomain } from './security.js';

function supported(rules: AccessV3Rules): AccessV3Rules {
	return Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, row]) => {
		const values = Object.fromEntries(ACCESS_V3_LIVE_PERMISSIONS.flatMap(key => row[key] == null ? [] : [[key, row[key]]]));
		return Object.keys(values).length ? [[id, values]] : [];
	}));
}
const count = (rules: AccessV3Rules): number => Object.values(rules).reduce((n, row) => n + Object.keys(row).length, 0);

export function previewAccessV3Publication(record: AccessV3RecordFile, directory: AccessV3Directory): { preview: AccessV3PublicationPreview; rules: Pick<AccessV3Publication, 'departments' | 'employees'> } {
	if (record.pilot?.active) throw new Error('Сначала отключите узкий пилот владельца.');
	const rules = {
		departments: validateAccessV3Rules(supported(record.current.departments), directory.departments.map(d => String(d.id)), ACCESS_V3_LIVE_PERMISSIONS),
		employees: validateAccessV3Rules(supported(record.current.employees), directory.users.map(u => u.id), ACCESS_V3_LIVE_PERMISSIONS),
	};
	const old = record.publication?.active ? record.publication : emptyAccessV3Publication();
	const changes: AccessV3PublicationPreview['changes'] = [];
	for (const user of directory.users) for (const permissionId of ACCESS_V3_LIVE_PERMISSIONS) {
		const before = resolveAccessV3Override(old, user, permissionId, directory.departments);
		const after = resolveAccessV3Override(rules, user, permissionId, directory.departments);
		if (after?.conflict) throw new Error(`Конфликт отделов: ${user.name}, ${permissionId}. Устраните конфликт или задайте личное исключение.`);
		if (before?.value !== after?.value || before?.source !== after?.source) changes.push({ userId: user.id, name: user.name, permissionId, before: before?.value ?? 'inherit', after: after?.value ?? 'inherit', source: after?.source ?? 'Прежние правила приложения' });
	}
	const proposal = { revision: record.publication?.revision ?? 0, draftRevision: record.current.revision, directoryFingerprint: directory.fingerprint };
	const ruleCount = count(rules.departments) + count(rules.employees);
	return { rules, preview: { ...proposal, token: createHash('sha256').update(JSON.stringify({ ...proposal, rules })).digest('hex'), changes, ruleCount, ignoredRules: count(record.current.departments) + count(record.current.employees) - ruleCount } };
}

/** Frozen rules, fresh authenticated department membership, live legacy inheritance. */
export function registerAccessV3Publication(app: FastifyInstance, store = new AccessV3Store(), directoryReader = readAccessV3Directory): void {
	app.decorateRequest('accessV3Rules', null);
	app.addHook('preHandler', async (req, reply) => {
		if (!String(req.routeOptions.url ?? '').startsWith('/api/catalog/')) return;
		try {
			const record = await store.read(normalizeDomain(app.config.portalDomain));
			if (!record?.publication?.active) return;
			const body = (req.body ?? {}) as Record<string, unknown>;
			const client = accessClientFrom(app, { domain: String(body.domain ?? ''), accessToken: String(body.accessToken ?? '') });
			if (!client) return reply.code(403).send({ ok: false, error: 'Для проверки прав нужна действующая сессия Битрикс24.' });
			const actor = await bounded(client.call<{ ID?: unknown; UF_DEPARTMENT?: unknown; ACTIVE?: unknown }>('user.current', {}), 5000);
			const id = String(actor.ID ?? '');
			if (!/^\d{1,12}$/.test(id) || !Array.isArray(actor.UF_DEPARTMENT) || actor.UF_DEPARTMENT.some(d => !Number.isSafeInteger(Number(d)) || Number(d) <= 0) || actor.ACTIVE === false || actor.ACTIVE === 'N') throw new Error('Не подтверждены пользователь и отделы.');
			const user = { id, name: '', departments: [...new Set(actor.UF_DEPARTMENT.map(Number))] };
			req.accessV3Rules = Object.fromEntries(ACCESS_V3_LIVE_PERMISSIONS.flatMap(key => {
				const result = resolveAccessV3Override(record.publication!, user, key, []);
				return result ? [[key, result.value]] : [];
			}));
		} catch {
			return reply.code(503).send({ ok: false, error: 'Не удалось безопасно проверить действующие права каталога. Повторите запрос или обратитесь к владельцу.' });
		}
	});
	for (const action of ['status', 'preview', 'activate', 'disable'] as const) app.post(`/api/access-control/v3/publication/${action}`, async (req, reply) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const client = accessClientFrom(app, { domain: String(body.domain ?? ''), accessToken: String(body.accessToken ?? '') });
		if (!client) return reply.code(403).send({ ok: false, error: 'Нужна действующая сессия Битрикс24.' });
		try {
			const actor = await bounded(client.call<{ ID?: unknown; ADMIN?: unknown }>('user.current', {}), 5000);
			const id = String(actor.ID ?? '');
			if (!/^\d{1,12}$/.test(id)) return reply.code(403).send({ ok: false, error: 'Не подтверждён пользователь Битрикс24.' });
			// Deliberately independent of configurable permissions: owner cannot lock themselves out.
			if (id !== APP_OWNER_USER_ID && (action !== 'status' || (!ACCESS_MANAGER_IDS.has(id) && actor.ADMIN !== true && actor.ADMIN !== 'Y'))) return reply.code(403).send({ ok: false, error: 'Применять и отключать рабочие права может только владелец #1858.' });
			const domain = normalizeDomain(app.config.portalDomain);
			const result = (r: AccessV3RecordFile | null) => ({ ok: true, state: r?.publication ?? emptyAccessV3Publication(), history: r?.publicationHistory ?? [], canActivate: id === APP_OWNER_USER_ID });
			const record = await store.read(domain);
			if (action === 'status') return result(record);
			if (!record) throw new Error('Сначала сохраните черновик прав.');
			if (action === 'disable') return result(await store.publishRules(domain, r => ({ ...emptyAccessV3Publication(), revision: (r.publication?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), updatedById: id })));
			const directory = await directoryReader(client);
			if (action === 'preview') return { ok: true, ...previewAccessV3Publication(record, directory).preview };
			return result(await store.publishRules(domain, latest => {
				const { preview, rules } = previewAccessV3Publication(latest, directory);
				if (body.previewToken !== preview.token || body.revision !== preview.revision || body.draftRevision !== preview.draftRevision || body.directoryFingerprint !== preview.directoryFingerprint) throw new Error('Изменились правила или состав сотрудников. Заново проверьте применение.');
				return { ...emptyAccessV3Publication(), ...rules, active: true, revision: preview.revision + 1, draftRevision: preview.draftRevision, directoryFingerprint: directory.fingerprint, updatedAt: new Date().toISOString(), updatedById: id };
			}));
		} catch (error) { return reply.code(409).send({ ok: false, error: error instanceof Error ? error.message : 'Не удалось применить права.' }); }
	});
}

declare module 'fastify' { interface FastifyRequest { accessV3Rules: Record<string, string> | null } }
