import type { FastifyInstance } from 'fastify';
import { canGrantAdministrator, type AccessControlDraft } from '@b24-app/shared';
import { accessPolicyEditError, changedSubjects, withAccessPolicySave } from '../access-policy-edit.js';
import { normalizeDomain } from '../security.js';
import { writeAccessPolicy } from '../access-policy-store.js';
import { B24ApiError, B24Client } from '../b24/client.js';
import {
	ACCESS_MANAGER_IDS,
	ACCESS_POLICY_EDITOR_ENABLED,
	ACCESS_POLICY_ENFORCEMENT_ENABLED,
	accessClientFrom,
	cacheAccessPolicy,
	loadAccessPolicy,
	resolveCurrentAccess,
	sanitizeAccessRules,
	type AccessAuthBody,
} from '../access-policy.js';

interface CurrentManager {
	id: string;
	name: string;
}

function errInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : String(error);
}

async function requireManager(
	app: FastifyInstance,
	body: AccessAuthBody,
	client: B24Client,
): Promise<CurrentManager | null> {
	const user = await client.call<{
		ID?: string | number;
		NAME?: string;
		LAST_NAME?: string;
		ADMIN?: boolean | string;
	}>('user.current', {}).catch(() => null);
	const id = String(user?.ID ?? '');
	if (!ACCESS_MANAGER_IDS.has(id)) {
		const access = await resolveCurrentAccess(app, body, true);
		if (!access?.canManageAccess) return null;
	}
	return {
		id,
		name: `${user?.LAST_NAME ?? ''} ${user?.NAME ?? ''}`.trim() || `#${id}`,
	};
}

async function allSubjects(client: B24Client, method: string, params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	let start = 0;
	const seen = new Set<number>();
	while (!seen.has(start)) {
		seen.add(start);
		const page = await client.callWithMeta<Array<Record<string, unknown>>>(method, { ...params, start });
		rows.push(...(Array.isArray(page.result) ? page.result : []));
		if (page.next === undefined || page.next === null) return rows;
		start = Number(page.next);
		if (!Number.isInteger(start) || start < 0) throw new Error('Некорректная страница справочника');
	}
	throw new Error('Справочник вернул повторную страницу');
}

export function registerApiAccessControlRoute(app: FastifyInstance): void {
	app.post('/api/access-control/me', async (req, reply) => {
		const body = (req.body ?? {}) as AccessAuthBody;
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		if (!ACCESS_POLICY_ENFORCEMENT_ENABLED && !ACCESS_POLICY_EDITOR_ENABLED) {
			return {
				ok: true,
				user: null,
				policyMode: 'draft' as const,
				decisions: {},
				canManageAccess: false,
			};
		}
		try {
			const access = await resolveCurrentAccess(app, body);
			if (!access) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
			return {
				ok: true,
				user: access.user,
				policyMode: access.policy.policyMode,
				decisions: access.decisions,
				canManageAccess: access.canManageAccess,
				canGrantAdministrator: canGrantAdministrator(access.user.id),
			};
		} catch (error) {
			app.log.error({}, `[api/access-control/me] ${errInfo(error)}`);
			// Нельзя блокировать загрузку приложения из-за временной ошибки Битрикса.
			const fallbackUser = await client.call<{
				ID?: string | number;
				NAME?: string;
				LAST_NAME?: string;
				ADMIN?: boolean | string;
				UF_DEPARTMENT?: unknown;
			}>('user.current', {}).catch(() => null);
			const id = String(fallbackUser?.ID ?? '');
			const isPortalAdmin = fallbackUser?.ADMIN === true || String(fallbackUser?.ADMIN ?? '').toUpperCase() === 'Y';
			return {
				ok: true,
				user: id ? {
					id,
					name: `${fallbackUser?.LAST_NAME ?? ''} ${fallbackUser?.NAME ?? ''}`.trim() || `#${id}`,
					departments: Array.isArray(fallbackUser?.UF_DEPARTMENT)
						? fallbackUser.UF_DEPARTMENT.map(Number).filter(Number.isFinite)
						: [],
					isPortalAdmin,
				} : null,
				policyMode: 'draft',
				decisions: {},
				canManageAccess: ACCESS_MANAGER_IDS.has(id),
			};
		}
	});

	app.post('/api/access-control/load', async (req, reply) => {
		const body = (req.body ?? {}) as AccessAuthBody;
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		const manager = await requireManager(app, body, client);
		if (!manager) return reply.code(403).send({ ok: false, error: 'окно доступно только руководству и администраторам' });
		try {
			return {
				ok: true,
				draft: await loadAccessPolicy(client, String(body.domain ?? ''), true),
				manager,
			};
		} catch (error) {
			app.log.error({}, `[api/access-control/load] ${errInfo(error)}`);
			return reply.code(502).send({ ok: false, error: 'не удалось загрузить права' });
		}
	});

	app.post('/api/access-control/users', async (req, reply) => {
		const body = (req.body ?? {}) as AccessAuthBody;
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		if (!(await requireManager(app, body, client))) {
			return reply.code(403).send({ ok: false, error: 'окно доступно только руководству и администраторам' });
		}
		try {
			const rawUsers = await allSubjects(client, 'user.get', {
				FILTER: { ACTIVE: true },
				SORT: 'LAST_NAME',
				ORDER: 'ASC',
			});
			const users = (Array.isArray(rawUsers) ? rawUsers : [])
				.map((user) => ({
					id: String(user['ID'] ?? ''),
					name: `${user['LAST_NAME'] ?? ''} ${user['NAME'] ?? ''}`.trim() || `#${user['ID'] ?? ''}`,
					position: String(user['WORK_POSITION'] ?? ''),
					departments: [...new Set(
						(Array.isArray(user['UF_DEPARTMENT']) ? user['UF_DEPARTMENT'] : [user['UF_DEPARTMENT']])
							.map(Number)
							.filter((id) => Number.isInteger(id) && id > 0),
					)].sort((a, b) => a - b),
				}))
				.filter((user) => /^\d{1,12}$/.test(user.id))
				.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
			const usedDepartmentIds = [...new Set(users.flatMap((user) => user.departments))].sort((a, b) => a - b);
			const names = new Map<number, string>([[10, 'Снабжение']]);
			try {
				const rawDepartments = await allSubjects(client, 'department.get', {});
				for (const department of Array.isArray(rawDepartments) ? rawDepartments : []) {
					const id = Number(department['ID'] ?? 0);
					const name = String(department['NAME'] ?? '').trim();
					if (id > 0 && name) names.set(id, name);
				}
			} catch (error) {
				// Некоторые установочные токены не имеют отдельного department scope.
				// Отдел всё равно доступен по ID из user.get и остаётся настраиваемым.
				app.log.warn({}, `[api/access-control/users] department names unavailable: ${errInfo(error)}`);
			}
			const departments = [...new Set([...usedDepartmentIds, ...names.keys()])]
				.map((id) => ({
					id,
					name: names.get(id) ?? `Отдел #${id}`,
					memberCount: users.filter((user) => user.departments.includes(id)).length,
				}))
				.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
			return { ok: true, users, departments };
		} catch (error) {
			app.log.error({}, `[api/access-control/users] ${errInfo(error)}`);
			return reply.code(502).send({ ok: false, error: 'не удалось загрузить сотрудников и отделы' });
		}
	});

	app.post('/api/access-control/save', async (req, reply) => {
		if (!ACCESS_POLICY_EDITOR_ENABLED) {
			return reply.code(503).send({
				ok: false,
				error: 'Настройка прав временно отключена',
			});
		}
		const body = (req.body ?? {}) as AccessAuthBody & { draft?: unknown };
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		return withAccessPolicySave(normalizeDomain(String(body.domain)), async () => {
		try {
			const manager = await requireManager(app, body, client);
			if (!manager) return reply.code(403).send({ ok: false, error: 'сохранять права может только администратор приложения' });
			const current = await loadAccessPolicy(client, String(body.domain ?? ''), true);
			const incoming = body.draft && typeof body.draft === 'object'
				? body.draft as Partial<AccessControlDraft>
				: {};
			if (Number(incoming.revision ?? -1) !== current.revision) {
				return reply.code(409).send({
					ok: false,
					error: 'права уже изменил другой пользователь — обновите окно',
					draft: current,
				});
			}
			const employees = sanitizeAccessRules(incoming.employees);
			const departments = sanitizeAccessRules(incoming.departments);
			const editError = accessPolicyEditError(manager.id, current, employees, departments);
			if (editError) return reply.code(403).send({ ok: false, error: editError });
			const changedUserIds = changedSubjects(current.employees, employees);
			const changedDepartmentIds = changedSubjects(current.departments, departments);
			const now = new Date().toISOString();
			const next: AccessControlDraft = {
				version: 2,
				revision: current.revision + 1,
				policyMode: 'active',
				employees,
				departments,
				updatedAt: now,
				updatedById: manager.id,
				updatedByName: manager.name,
				audit: [...current.audit, {
					at: now,
					byId: manager.id,
					byName: manager.name,
					changedUserIds,
					changedDepartmentIds,
				}].slice(-100),
			};
			const serialized = JSON.stringify(next);
			if (serialized.length > 55_000) {
				return reply.code(413).send({ ok: false, error: 'настройки слишком большие; сократите примечания или число исключений' });
			}
			await writeAccessPolicy(String(body.domain ?? ''), next);
			cacheAccessPolicy(String(body.domain ?? ''), next);
			app.log.info({ managerId: manager.id, changedUserIds, changedDepartmentIds }, '[api/access-control/save] active policy saved');
			return { ok: true, draft: next };
		} catch (error) {
			app.log.error({}, `[api/access-control/save] ${errInfo(error)}`);
			return reply.code(502).send({ ok: false, error: 'не удалось сохранить права' });
		}
		});
	});
}
