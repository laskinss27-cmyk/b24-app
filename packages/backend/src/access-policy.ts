import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
	ACCESS_PERMISSIONS,
	effectiveAccessDecision,
	emptyAccessControlDraft,
	type AccessControlDraft,
	type AccessPermissionId,
	type AccessProfileId,
	type AccessSubjectRule,
} from '@b24-app/shared';
import { B24Client } from './b24/client.js';
import { normalizeDomain } from './security.js';

export const ACCESS_POLICY_OPTION = 'ud_access_control_draft_v1';
export const ACCESS_MANAGER_IDS = new Set(['1', '986', '1858']);
/**
 * Emergency fail-open switch. The saved policy is intentionally preserved, but it
 * must not affect application access until the editor and rules are reviewed.
 */
export const ACCESS_POLICY_ENFORCEMENT_ENABLED = false;
export const ACCESS_POLICY_EDITOR_ENABLED = false;

const PROFILE_IDS = new Set<AccessProfileId>(['legacy', 'manager', 'supply', 'administrator', 'leadership']);
const PERMISSION_IDS = new Set<string>(ACCESS_PERMISSIONS.map((item) => item.id));
const SAFE_ID = /^\d{1,12}$/;
const POLICY_CACHE_MS = 15_000;
const USER_CACHE_MS = 5 * 60_000;

export interface AccessAuthBody {
	domain?: string;
	accessToken?: string;
}

export interface AccessUser {
	id: string;
	name: string;
	departments: number[];
	isPortalAdmin: boolean;
}

export interface CurrentAccess {
	user: AccessUser;
	policy: AccessControlDraft;
	decisions: Record<AccessPermissionId, 'inherit' | 'allow' | 'deny'>;
	canManageAccess: boolean;
}

const policyCache = new Map<string, { expiresAt: number; policy: AccessControlDraft }>();
const userCache = new Map<string, { expiresAt: number; user: AccessUser }>();

export function accessClientFrom(app: FastifyInstance, body: AccessAuthBody): B24Client | null {
	const domain = String(body.domain ?? '');
	const accessToken = String(body.accessToken ?? '');
	if (!domain || !accessToken || normalizeDomain(domain) !== normalizeDomain(app.config.portalDomain)) return null;
	return new B24Client({ auth: { kind: 'oauth', domain, accessToken } });
}

export function sanitizeAccessRule(value: unknown): AccessSubjectRule {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	// Старый черновой «Сервис» нельзя автоматически превращать в полный админский
	// доступ только из-за переименования пункта меню — безопасно возвращаем наследование.
	const rawProfile = raw['profileId'] === 'service' ? 'legacy' : raw['profileId'];
	const profileId = PROFILE_IDS.has(rawProfile as AccessProfileId)
		? rawProfile as AccessProfileId
		: 'legacy';
	const inputOverrides = raw['overrides'] && typeof raw['overrides'] === 'object'
		? raw['overrides'] as Record<string, unknown>
		: {};
	const overrides: AccessSubjectRule['overrides'] = {};
	for (const [permissionId, decision] of Object.entries(inputOverrides)) {
		if (PERMISSION_IDS.has(permissionId) && (decision === 'allow' || decision === 'deny')) {
			overrides[permissionId as AccessPermissionId] = decision;
		}
	}
	const note = String(raw['note'] ?? '').trim().slice(0, 500);
	return { profileId, overrides, ...(note ? { note } : {}) };
}

export function sanitizeAccessRules(value: unknown): Record<string, AccessSubjectRule> {
	if (!value || typeof value !== 'object') return {};
	const out: Record<string, AccessSubjectRule> = {};
	for (const [id, rule] of Object.entries(value as Record<string, unknown>)) {
		if (SAFE_ID.test(id)) out[id] = sanitizeAccessRule(rule);
	}
	return out;
}

export function parseStoredAccessPolicy(value: unknown): AccessControlDraft {
	if (typeof value !== 'string' || !value) return emptyAccessControlDraft();
	try {
		const raw = JSON.parse(value) as Record<string, unknown>;
		const empty = emptyAccessControlDraft();
		const version = Number(raw['version']);
		return {
			...empty,
			revision: Number.isInteger(raw['revision']) && Number(raw['revision']) >= 0 ? Number(raw['revision']) : 0,
			// Старые сохранённые черновики не включаем автоматически. Они станут активными
			// только после осознанного сохранения в обновлённом окне.
			policyMode: version === 2 && raw['policyMode'] === 'active' ? 'active' : 'draft',
			employees: sanitizeAccessRules(raw['employees']),
			departments: version === 2 ? sanitizeAccessRules(raw['departments']) : {},
			updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null,
			updatedById: typeof raw['updatedById'] === 'string' ? raw['updatedById'] : null,
			updatedByName: typeof raw['updatedByName'] === 'string' ? raw['updatedByName'] : null,
			audit: Array.isArray(raw['audit'])
				? raw['audit'].filter((item) => item && typeof item === 'object').slice(-100) as AccessControlDraft['audit']
				: [],
		};
	} catch {
		return emptyAccessControlDraft();
	}
}

export async function loadAccessPolicy(client: B24Client, domain: string, force = false): Promise<AccessControlDraft> {
	const key = normalizeDomain(domain);
	const cached = policyCache.get(key);
	if (!force && cached && cached.expiresAt > Date.now()) return cached.policy;
	const options = await client.call<Record<string, unknown>>('app.option.get', {});
	const policy = parseStoredAccessPolicy(options?.[ACCESS_POLICY_OPTION]);
	policyCache.set(key, { expiresAt: Date.now() + POLICY_CACHE_MS, policy });
	return policy;
}

export function cacheAccessPolicy(domain: string, policy: AccessControlDraft): void {
	policyCache.set(normalizeDomain(domain), { expiresAt: Date.now() + POLICY_CACHE_MS, policy });
}

export function invalidateAccessPolicyCache(domain: string): void {
	policyCache.delete(normalizeDomain(domain));
}

async function loadAccessUser(client: B24Client, accessToken: string): Promise<AccessUser> {
	const cached = userCache.get(accessToken);
	if (cached && cached.expiresAt > Date.now()) return cached.user;
	const raw = await client.call<{
		ID?: string | number;
		NAME?: string;
		LAST_NAME?: string;
		UF_DEPARTMENT?: unknown;
		ADMIN?: boolean | string;
	}>('user.current', {});
	const id = String(raw?.ID ?? '');
	if (!SAFE_ID.test(id)) throw new Error('user.current не вернул ID');
	const departments = [...new Set(
		(Array.isArray(raw?.UF_DEPARTMENT) ? raw.UF_DEPARTMENT : [raw?.UF_DEPARTMENT])
			.map(Number)
			.filter((item) => Number.isInteger(item) && item > 0),
	)].sort((a, b) => a - b);
	const user: AccessUser = {
		id,
		name: `${raw?.LAST_NAME ?? ''} ${raw?.NAME ?? ''}`.trim() || `#${id}`,
		departments,
		isPortalAdmin: raw?.ADMIN === true || String(raw?.ADMIN ?? '').toUpperCase() === 'Y',
	};
	userCache.set(accessToken, { expiresAt: Date.now() + USER_CACHE_MS, user });
	if (userCache.size > 500) {
		const now = Date.now();
		for (const [token, entry] of userCache) if (entry.expiresAt <= now) userCache.delete(token);
	}
	return user;
}

export async function resolveCurrentAccess(
	app: FastifyInstance,
	body: AccessAuthBody,
	forcePolicy = false,
): Promise<CurrentAccess | null> {
	const client = accessClientFrom(app, body);
	const domain = String(body.domain ?? '');
	const accessToken = String(body.accessToken ?? '');
	if (!client) return null;
	const [user, policy] = await Promise.all([
		loadAccessUser(client, accessToken),
		loadAccessPolicy(client, domain, forcePolicy),
	]);
	const departmentRules = user.departments.map((id) => policy.departments[String(id)]);
	const decisions = Object.fromEntries(ACCESS_PERMISSIONS.map((permission) => [
		permission.id,
		ACCESS_POLICY_ENFORCEMENT_ENABLED && policy.policyMode === 'active'
			? effectiveAccessDecision(policy.employees[user.id], departmentRules, permission.id)
			: 'inherit',
	])) as Record<AccessPermissionId, 'inherit' | 'allow' | 'deny'>;
	const canManageAccess = ACCESS_MANAGER_IDS.has(user.id)
		|| user.isPortalAdmin
		|| decisions['admin.manage_access'] === 'allow';
	return { user, policy, decisions, canManageAccess };
}

export async function hasAppPermissions(
	app: FastifyInstance,
	body: AccessAuthBody,
	permissionIds: readonly AccessPermissionId[],
): Promise<{ allowed: boolean; denied: AccessPermissionId[]; access: CurrentAccess | null }> {
	const access = await resolveCurrentAccess(app, body);
	if (!access) return { allowed: true, denied: [], access: null };
	if (!ACCESS_POLICY_ENFORCEMENT_ENABLED || access.policy.policyMode !== 'active') {
		return { allowed: true, denied: [], access };
	}
	const denied = permissionIds.filter((permissionId) => access.decisions[permissionId] === 'deny');
	return { allowed: denied.length === 0, denied, access };
}

/** Явное правило приложения сильнее старой проверки роли; inherit оставляет её как есть. */
export function appPermission(
	req: FastifyRequest,
	permissionId: AccessPermissionId,
	legacyAllowed: boolean,
): boolean {
	const decision = req.appAccess?.decisions[permissionId] ?? 'inherit';
	return decision === 'allow' ? true : decision === 'deny' ? false : legacyAllowed;
}

declare module 'fastify' {
	interface FastifyRequest {
		appAccess: CurrentAccess | null;
	}
}
