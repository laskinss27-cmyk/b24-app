import type { FastifyInstance } from 'fastify';
import type { AccessControlDraft, AccessSubjectRule } from '@b24-app/shared';
import { B24ApiError, B24Client } from '../b24/client.js';
import {
	ACCESS_MANAGER_IDS,
	ACCESS_POLICY_OPTION,
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
	const portalAdmin = user?.ADMIN === true || String(user?.ADMIN ?? '').toUpperCase() === 'Y';
	if (!ACCESS_MANAGER_IDS.has(id) && !portalAdmin) {
		const access = await resolveCurrentAccess(app, body);
		if (!access?.canManageAccess) return null;
	}
	return {
		id,
		name: `${user?.LAST_NAME ?? ''} ${user?.NAME ?? ''}`.trim() || `#${id}`,
	};
}

function changedSubjects(
	before: Record<string, AccessSubjectRule>,
	after: Record<string, AccessSubjectRule>,
): string[] {
	const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...ids].filter((id) => JSON.stringify(before[id] ?? null) !== JSON.stringify(after[id] ?? null));
}

export function registerApiAccessControlRoute(app: FastifyInstance): void {
	app.post('/api/access-control/me', async (req, reply) => {
		const body = (req.body ?? {}) as AccessAuthBody;
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		try {
			const access = await resolveCurrentAccess(app, body);
			if (!access) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
			return {
				ok: true,
				user: access.user,
				policyMode: access.policy.policyMode,
				decisions: access.decisions,
				canManageAccess: access.canManageAccess,
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
				canManageAccess: ACCESS_MANAGER_IDS.has(id) || isPortalAdmin,
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
			const rawUsers = await client.call<Array<Record<string, unknown>>>('user.get', {
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
				const rawDepartments = await client.call<Array<Record<string, unknown>>>('department.get', {});
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
			const departments = usedDepartmentIds
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
		const body = (req.body ?? {}) as AccessAuthBody & { draft?: unknown };
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		const manager = await requireManager(app, body, client);
		if (!manager) return reply.code(403).send({ ok: false, error: 'сохранять права может только руководство или администратор' });
		try {
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
			await client.call('app.option.set', { options: { [ACCESS_POLICY_OPTION]: serialized } });
			cacheAccessPolicy(String(body.domain ?? ''), next);
			app.log.info({ managerId: manager.id, changedUserIds, changedDepartmentIds }, '[api/access-control/save] active policy saved');
			return { ok: true, draft: next };
		} catch (error) {
			app.log.error({}, `[api/access-control/save] ${errInfo(error)}`);
			return reply.code(502).send({ ok: false, error: 'не удалось сохранить права' });
		}
	});
}
