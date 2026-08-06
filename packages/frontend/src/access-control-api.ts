import type { AccessControlDraft, AccessDecision, AccessPermissionId } from '@b24-app/shared';
import { bx24Auth } from './bitrix-auth.js';

export interface AccessEmployee {
	id: string;
	name: string;
	position: string;
	departments: number[];
}

export interface AccessDepartment {
	id: number;
	name: string;
	memberCount: number;
}

export interface CurrentAppAccess {
	user: { id: string; name: string; departments: number[]; isPortalAdmin: boolean } | null;
	policyMode: 'draft' | 'active';
	decisions: Partial<Record<AccessPermissionId, AccessDecision>>;
	canManageAccess: boolean;
}

async function accessControlRequest<T>(path: 'me' | 'load' | 'users' | 'save', extra: Record<string, unknown> = {}): Promise<T> {
	const response = await fetch(`/api/access-control/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...extra }),
	});
	const json = await response.json() as { ok?: boolean; error?: string };
	if (!response.ok || !json.ok) throw new Error(json.error ?? 'не удалось выполнить запрос прав');
	return json as T;
}

export async function fetchAccessControlDraft(): Promise<AccessControlDraft> {
	const result = await accessControlRequest<{ ok: true; draft: AccessControlDraft }>('load');
	return result.draft;
}

export async function fetchAccessEmployees(): Promise<AccessEmployee[]> {
	const result = await fetchAccessSubjects();
	return result.users;
}

export async function fetchAccessSubjects(): Promise<{ users: AccessEmployee[]; departments: AccessDepartment[] }> {
	const result = await accessControlRequest<{
		ok: true;
		users: AccessEmployee[];
		departments: AccessDepartment[];
	}>('users');
	return { users: result.users, departments: result.departments };
}

export async function fetchCurrentAppAccess(): Promise<CurrentAppAccess> {
	const result = await accessControlRequest<{ ok: true } & CurrentAppAccess>('me');
	return {
		user: result.user,
		policyMode: result.policyMode,
		decisions: result.decisions,
		canManageAccess: result.canManageAccess,
	};
}

export async function saveAccessControlDraft(draft: AccessControlDraft): Promise<AccessControlDraft> {
	const result = await accessControlRequest<{ ok: true; draft: AccessControlDraft }>('save', { draft });
	return result.draft;
}
