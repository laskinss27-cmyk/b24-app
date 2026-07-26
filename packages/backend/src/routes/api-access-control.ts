import type { FastifyInstance } from 'fastify';
import type {
	AccessControlDraft,
	AccessPermissionId,
	AccessProfileId,
	EmployeeAccessDraft,
} from '@b24-app/shared';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

interface CurrentManager {
	id: string;
	name: string;
}

const ACCESS_DRAFT_OPTION = 'ud_access_control_draft_v1';
const ACCESS_MANAGER_IDS = new Set(['1', '986', '1858']);
const PROFILE_IDS = new Set<AccessProfileId>(['legacy', 'manager', 'supply', 'service', 'leadership']);
const SAFE_PERMISSION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function emptyAccessControlDraft(): AccessControlDraft {
	return {
		version: 1,
		revision: 0,
		policyMode: 'draft',
		employees: {},
		updatedAt: null,
		updatedById: null,
		updatedByName: null,
		audit: [],
	};
}

function clientFrom(app: FastifyInstance, body: AuthBody): B24Client | null {
	const domain = String(body.domain ?? '');
	const accessToken = String(body.accessToken ?? '');
	if (!domain || !accessToken || normalizeDomain(domain) !== normalizeDomain(app.config.portalDomain)) return null;
	return new B24Client({ auth: { kind: 'oauth', domain, accessToken } });
}

function errInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : String(error);
}

async function requireManager(client: B24Client): Promise<CurrentManager | null> {
	const user = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; ADMIN?: boolean }>('user.current', {}).catch(() => null);
	const id = String(user?.ID ?? '');
	if (!ACCESS_MANAGER_IDS.has(id) && user?.ADMIN !== true) return null;
	return {
		id,
		name: `${user?.NAME ?? ''} ${user?.LAST_NAME ?? ''}`.trim() || `#${id}`,
	};
}

function sanitizeEmployee(value: unknown): EmployeeAccessDraft {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const profileId = PROFILE_IDS.has(raw['profileId'] as AccessProfileId)
		? raw['profileId'] as AccessProfileId
		: 'legacy';
	const inputOverrides = raw['overrides'] && typeof raw['overrides'] === 'object'
		? raw['overrides'] as Record<string, unknown>
		: {};
	const overrides: EmployeeAccessDraft['overrides'] = {};
	for (const [permissionId, decision] of Object.entries(inputOverrides)) {
		// Черновик не применяется рабочими API. Ограничиваем формат ключа, но не дублируем
		// здесь весь каталог прав: новые пункты интерфейса должны безопасно сохраняться
		// без runtime-импорта shared-пакета.
		if (permissionId.length <= 80 && SAFE_PERMISSION_ID.test(permissionId) && (decision === 'allow' || decision === 'deny')) {
			overrides[permissionId as AccessPermissionId] = decision;
		}
	}
	const note = String(raw['note'] ?? '').trim().slice(0, 500);
	return { profileId, overrides, ...(note ? { note } : {}) };
}

function sanitizeEmployees(value: unknown): Record<string, EmployeeAccessDraft> {
	if (!value || typeof value !== 'object') return {};
	const out: Record<string, EmployeeAccessDraft> = {};
	for (const [userId, employee] of Object.entries(value as Record<string, unknown>)) {
		if (!/^\d{1,12}$/.test(userId)) continue;
		out[userId] = sanitizeEmployee(employee);
	}
	return out;
}

function parseStoredDraft(value: unknown): AccessControlDraft {
	if (typeof value !== 'string' || !value) return emptyAccessControlDraft();
	try {
		const raw = JSON.parse(value) as Partial<AccessControlDraft>;
		const draft = emptyAccessControlDraft();
		return {
			...draft,
			revision: Number.isInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0,
			employees: sanitizeEmployees(raw.employees),
			updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
			updatedById: typeof raw.updatedById === 'string' ? raw.updatedById : null,
			updatedByName: typeof raw.updatedByName === 'string' ? raw.updatedByName : null,
			audit: Array.isArray(raw.audit) ? raw.audit.slice(-100) : [],
		};
	} catch {
		return emptyAccessControlDraft();
	}
}

async function loadDraft(client: B24Client): Promise<AccessControlDraft> {
	const options = await client.call<Record<string, unknown>>('app.option.get', {});
	return parseStoredDraft(options?.[ACCESS_DRAFT_OPTION]);
}

function changedUsers(
	before: Record<string, EmployeeAccessDraft>,
	after: Record<string, EmployeeAccessDraft>,
): string[] {
	const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...ids].filter((id) => JSON.stringify(before[id] ?? null) !== JSON.stringify(after[id] ?? null));
}

/**
 * Скрытая панель настройки будущих прав.
 *
 * Здесь намеренно нет endpoint-а активации. Сохранённый документ имеет policyMode=draft
 * и ни один рабочий API его пока не читает — текущие права сотрудников не меняются.
 */
export function registerApiAccessControlRoute(app: FastifyInstance): void {
	app.post('/api/access-control/load', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		const manager = await requireManager(client);
		if (!manager) return reply.code(403).send({ ok: false, error: 'окно доступно только руководству' });
		try {
			return { ok: true, draft: await loadDraft(client), manager };
		} catch (error) {
			app.log.error({}, `[api/access-control/load] ${errInfo(error)}`);
			return reply.code(502).send({ ok: false, error: 'не удалось загрузить черновик прав' });
		}
	});

	app.post('/api/access-control/users', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		if (!(await requireManager(client))) return reply.code(403).send({ ok: false, error: 'окно доступно только руководству' });
		try {
			const raw = await client.call<Array<Record<string, unknown>>>('user.get', {
				FILTER: { ACTIVE: true },
				SORT: 'LAST_NAME',
				ORDER: 'ASC',
			});
			const users = (Array.isArray(raw) ? raw : [])
				.map((user) => ({
					id: String(user['ID'] ?? ''),
					name: `${user['LAST_NAME'] ?? ''} ${user['NAME'] ?? ''}`.trim() || `#${user['ID'] ?? ''}`,
					position: String(user['WORK_POSITION'] ?? ''),
					departments: Array.isArray(user['UF_DEPARTMENT']) ? user['UF_DEPARTMENT'].map(Number).filter(Number.isFinite) : [],
				}))
				.filter((user) => user.id)
				.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
			return { ok: true, users };
		} catch (error) {
			app.log.error({}, `[api/access-control/users] ${errInfo(error)}`);
			return reply.code(502).send({ ok: false, error: 'не удалось загрузить сотрудников' });
		}
	});

	app.post('/api/access-control/save', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { draft?: unknown };
		const client = clientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		const manager = await requireManager(client);
		if (!manager) return reply.code(403).send({ ok: false, error: 'сохранять права может только руководство' });
		try {
			const current = await loadDraft(client);
			const incoming = body.draft && typeof body.draft === 'object'
				? body.draft as Partial<AccessControlDraft>
				: {};
			if (Number(incoming.revision ?? -1) !== current.revision) {
				return reply.code(409).send({
					ok: false,
					error: 'черновик уже изменил другой пользователь — обновите окно',
					draft: current,
				});
			}
			const employees = sanitizeEmployees(incoming.employees);
			const changedUserIds = changedUsers(current.employees, employees);
			const now = new Date().toISOString();
			const next: AccessControlDraft = {
				version: 1,
				revision: current.revision + 1,
				policyMode: 'draft',
				employees,
				updatedAt: now,
				updatedById: manager.id,
				updatedByName: manager.name,
				audit: [...current.audit, { at: now, byId: manager.id, byName: manager.name, changedUserIds }].slice(-100),
			};
			const serialized = JSON.stringify(next);
			if (serialized.length > 55_000) {
				return reply.code(413).send({ ok: false, error: 'черновик слишком большой; сократите примечания или число исключений' });
			}
			await client.call('app.option.set', { options: { [ACCESS_DRAFT_OPTION]: serialized } });
			app.log.info({ managerId: manager.id, changedUserIds }, '[api/access-control/save] draft saved (not enforced)');
			return { ok: true, draft: next };
		} catch (error) {
			app.log.error({}, `[api/access-control/save] ${errInfo(error)}`);
			return reply.code(502).send({ ok: false, error: 'не удалось сохранить черновик прав' });
		}
	});
}
