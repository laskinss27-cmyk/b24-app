import { APP_OWNER_USER_ID, resolveAccessV3Override, type AccessV3Draft, type AccessV3Person, type AccessV3ShadowObservation, type AccessV3ShadowReport } from '@b24-app/shared';
import type { FastifyInstance } from 'fastify';
import { accessClientFrom } from './access-policy.js';
import { AccessV3Store } from './access-v3-store.js';
import { normalizeDomain } from './security.js';

// Deliberately no active mode, wildcard users or mutation routes. Expand only after a separate review.
export const ACCESS_V3_SHADOW_PERMISSION = 'catalog.view_purchase_prices';
export const ACCESS_V3_SHADOW_ROUTES = ['/api/catalog/browse', '/api/catalog/erp-stocks', '/api/catalog/export-marketplace-selection'] as const;

export function compareAccessV3Role(draft: AccessV3Draft | null, user: AccessV3Person, permissionId: string, actual: boolean): Pick<AccessV3ShadowObservation, 'actual' | 'proposed' | 'source' | 'conflict'> {
	if (permissionId !== ACCESS_V3_SHADOW_PERMISSION) throw new Error('Проверка не входит в пилот');
	if (draft && (draft.version !== 3 || draft.mode !== 'draft')) throw new Error('Неподдерживаемая версия правил');
	const rule = draft ? resolveAccessV3Override(draft, user, permissionId, []) : null;
	return { actual, proposed: rule ? rule.value === 'allow' : actual, source: rule?.source ?? 'Текущая проверка маршрута', conflict: rule?.conflict ?? false };
}

/** Process-local, bounded diagnostics. No prices, tokens, document IDs or request payloads. */
export class AccessV3Shadow {
	private readonly report: AccessV3ShadowReport = {
		mode: 'shadow', enforcement: false, userIds: [APP_OWNER_USER_ID], permissionIds: [ACCESS_V3_SHADOW_PERMISSION],
		routes: [...ACCESS_V3_SHADOW_ROUTES], startedAt: new Date().toISOString(), total: 0, differences: 0, skipped: 0, lastSkip: null, observations: [],
	};
	snapshot(): AccessV3ShadowReport { return structuredClone(this.report); }
	skip(reason: 'auth' | 'unavailable' | 'invalid-rule' | 'timeout'): void {
		this.report.skipped++;
		this.report.lastSkip = { auth: 'Не подтверждён участник пилота', unavailable: 'Не удалось прочитать черновик или пользователя', 'invalid-rule': 'Неподдерживаемое правило', timeout: 'Превышено время проверки' }[reason];
	}
	record(observation: AccessV3ShadowObservation): void {
		if (observation.userId !== APP_OWNER_USER_ID || observation.permissionId !== ACCESS_V3_SHADOW_PERMISSION || !this.report.routes.includes(observation.route)) return;
		this.report.total++;if (observation.actual !== observation.proposed) this.report.differences++;
		this.report.observations.push(observation);
		if (this.report.observations.length > 200) this.report.observations.shift();
	}
}

export async function bounded<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('shadow-timeout')), timeoutMs); })]); }
	finally { if (timer) clearTimeout(timer); }
}

export function registerAccessV3Shadow(app: FastifyInstance, shadow = new AccessV3Shadow(), store = new AccessV3Store(), timeoutMs = 1500): AccessV3Shadow {
	app.decorate('accessV3Shadow', shadow);
	app.decorateRequest('accessV3Observe', null);
	const pending = new WeakMap<object, Omit<AccessV3ShadowObservation, 'httpStatus'>[]>();
	app.addHook('preHandler', async req => {
		const route = String(req.routeOptions.url ?? '');
		if (!(ACCESS_V3_SHADOW_ROUTES as readonly string[]).includes(route) || req.appAccess?.user.id !== APP_OWNER_USER_ID) return;
		const body = (req.body ?? {}) as Record<string, unknown>;
		try {
			const client = accessClientFrom(app, { domain: String(body.domain ?? ''), accessToken: String(body.accessToken ?? '') });
			if (!client) { shadow.skip('auth');return; }
			// Verify fresh identity and membership; never trust an employeeId from the browser or a cached role alone.
			const [actor, saved] = await bounded(Promise.all([
				client.call<{ ID?: unknown; UF_DEPARTMENT?: unknown }>('user.current', {}), store.read(normalizeDomain(String(body.domain))),
			]), timeoutMs);
			if (String(actor.ID ?? '') !== APP_OWNER_USER_ID || !Array.isArray(actor.UF_DEPARTMENT) || actor.UF_DEPARTMENT.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) { shadow.skip('auth');return; }
			const user: AccessV3Person = { id: APP_OWNER_USER_ID, name: '', departments: [...new Set(actor.UF_DEPARTMENT.map(Number))] };
			const rows: Omit<AccessV3ShadowObservation, 'httpStatus'>[] = [];pending.set(req, rows);
			req.accessV3Observe = (permissionId, actual) => {
				if (permissionId !== ACCESS_V3_SHADOW_PERMISSION || rows.length) return;
				try { rows.push({ at: new Date().toISOString(), revision: saved?.current.revision ?? 0, userId: user.id, route, permissionId, ...compareAccessV3Role(saved?.current ?? null, user, permissionId, actual) }); }
				catch { shadow.skip('invalid-rule'); }
			};
		} catch (error) { shadow.skip(error instanceof Error && error.message === 'shadow-timeout' ? 'timeout' : 'unavailable'); }
	});
	app.addHook('onResponse', async (req, reply) => {
		try { for (const row of pending.get(req) ?? []) shadow.record({ ...row, httpStatus: reply.statusCode }); }
		finally { pending.delete(req); }
	});
	return shadow;
}

declare module 'fastify' {
	interface FastifyInstance { accessV3Shadow?: AccessV3Shadow }
	interface FastifyRequest { accessV3Observe: ((permissionId: string, actual: boolean) => void) | null }
}
