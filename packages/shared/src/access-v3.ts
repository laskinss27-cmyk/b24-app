import { ACCESS_PERMISSIONS } from './access-control.js';

export type AccessV3Decision = 'allow' | 'deny';
export type AccessV3Value = AccessV3Decision | 'context';
export type AccessV3Rules = Record<string, Record<string, AccessV3Decision>>;
export interface AccessV3Person { id: string; name: string; departments: number[]; position?: string; firstName?: string; lastName?: string }
export interface AccessV3Department { id: number; name: string }
export interface AccessV3Directory { users: AccessV3Person[]; departments: AccessV3Department[]; stores: string[]; fingerprint: string }
export interface AccessV3BaselineCell { value: AccessV3Value; reason: string }
export interface AccessV3Baseline {
	capturedAt: string;
	directoryFingerprint: string;
	users: Record<string, Record<string, AccessV3BaselineCell>>;
	departments: Record<string, Record<string, AccessV3BaselineCell>>;
}
export interface AccessV3Draft {
	version: 3; mode: 'draft'; revision: number;
	departments: AccessV3Rules; employees: AccessV3Rules;
	baseline: AccessV3Baseline;
	updatedAt: string | null; updatedBy: string | null;
}
export interface AccessV3Permission { id: string; label: string; group: string; warehouse?: string }
export interface AccessV3Resolution { value: AccessV3Value; source: string; conflict: boolean }
export interface AccessV3Change { userId: string; name: string; permissionId: string; label: string; before: AccessV3Resolution; after: AccessV3Resolution }
export interface AccessV3Preview { changes: AccessV3Change[]; changedUsers: number; changedRules: number; token: string }
export interface AccessV3Response {
	draft: AccessV3Draft; directory: AccessV3Directory;
	history: Array<{ revision: number; updatedAt: string | null; updatedBy: string | null }>;
	shadow?: AccessV3ShadowReport;
}

export interface AccessV3ShadowObservation {
	at: string; revision: number; userId: string; route: string; permissionId: string;
	actual: boolean; proposed: boolean; source: string; conflict: boolean; httpStatus: number;
}
export interface AccessV3ShadowReport {
	mode: 'shadow'; enforcement: false; userIds: string[]; permissionIds: string[]; routes: string[];
	startedAt: string; total: number; differences: number; skipped: number;
	lastSkip: string | null; observations: AccessV3ShadowObservation[];
}

export interface AccessV3PilotState {
	version: 1; revision: number; active: boolean;
	userId: '1858'; permissionId: 'catalog.view_purchase_prices';
	decision: AccessV3Decision | null; draftRevision: number | null;
	updatedAt: string | null; updatedById: string | null;
}
export interface AccessV3PilotStatus { state: AccessV3PilotState; canActivate: boolean; history: AccessV3PilotState[] }
export interface AccessV3PilotPreview {
	token: string; pilotRevision: number; draftRevision: number;
	decision: AccessV3Decision; source: string; userId: '1858'; permissionId: 'catalog.view_purchase_prices';
}
export function emptyAccessV3Pilot(): AccessV3PilotState {
	return { version: 1, revision: 0, active: false, userId: '1858', permissionId: 'catalog.view_purchase_prices', decision: null, draftRevision: null, updatedAt: null, updatedById: null };
}

/** Explicit rules only: runtime inheritance must use today's role check, never a historical snapshot. */
export function resolveAccessV3Override(draft: AccessV3Draft, user: AccessV3Person, permissionId: string, departments: AccessV3Department[]): AccessV3Resolution | null {
	const personal = draft.employees[user.id]?.[permissionId];
	if (personal === 'allow' || personal === 'deny') return { value: personal, source: 'Личное исключение', conflict: false };
	if (personal != null) throw new Error('Некорректное личное правило');
	const rules = user.departments.flatMap(id => {
		const value = draft.departments[String(id)]?.[permissionId];
		if (value != null && value !== 'allow' && value !== 'deny') throw new Error('Некорректное правило отдела');
		return value ? [{ value, name: departments.find(d => d.id === id)?.name ?? `#${id}` }] : [];
	});
	const denied = rules.filter(r => r.value === 'deny');
	return rules.length ? { value: denied.length ? 'deny' : 'allow', source: `Отдел: ${(denied.length ? denied : rules).map(r => r.name).join(', ')}`, conflict: denied.length > 0 && denied.length < rules.length } : null;
}

export function accessV3Permissions(stores: readonly string[]): AccessV3Permission[] {
	return [
		...ACCESS_PERMISSIONS.map(p => ({ id: p.id, label: p.label, group: p.group })),
		...[...new Set(stores)].flatMap(store => (['view', 'sale', 'receipt', 'issue'] as const).map(action => ({
			id: `warehouse:${encodeURIComponent(store)}:${action}`, warehouse: store, group: 'Доступ по складам',
			label: `${store} — ${{ view: 'просмотр', sale: 'реализация', receipt: 'приход', issue: 'списание' }[action]}`,
		}))),
	];
}

export function resolveAccessV3(draft: AccessV3Draft, user: AccessV3Person, permissionId: string, directory: AccessV3Directory): AccessV3Resolution {
	const explicit = resolveAccessV3Override(draft, user, permissionId, directory.departments);
	if (explicit) return explicit;
	const base = draft.baseline.users[user.id]?.[permissionId];
	return { value: base?.value ?? 'context', source: base?.reason ?? 'Текущий доступ требует проверки; не меняем', conflict: false };
}

export function previewAccessV3(before: AccessV3Draft, after: AccessV3Draft, directory: AccessV3Directory): Omit<AccessV3Preview, 'token'> {
	const changes: AccessV3Change[] = [];
	for (const user of directory.users) for (const permission of accessV3Permissions(directory.stores)) {
		const a = resolveAccessV3(before, user, permission.id, directory);
		const b = resolveAccessV3(after, user, permission.id, directory);
		if (a.value !== b.value || a.conflict !== b.conflict) changes.push({ userId: user.id, name: user.name, permissionId: permission.id, label: permission.label, before: a, after: b });
	}
	let changedRules = 0;
	for (const kind of ['departments', 'employees'] as const) {
		for (const id of new Set([...Object.keys(before[kind]), ...Object.keys(after[kind])])) {
			const a = before[kind][id] ?? {}, b = after[kind][id] ?? {};
			for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[key] !== b[key]) changedRules++;
		}
	}
	return { changes, changedUsers: new Set(changes.map(c => c.userId)).size, changedRules };
}

/** Strict input: silently dropping an unrecognized denial could broaden access. */
export function validateAccessV3Rules(value: unknown, subjectIds: readonly string[], permissionIds: readonly string[]): AccessV3Rules {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректный набор прав');
	const subjects = new Set(subjectIds), permissions = new Set(permissionIds);
	const out: AccessV3Rules = {};
	for (const [subject, rules] of Object.entries(value)) {
		if (!subjects.has(subject)) throw new Error(`Сотрудник или отдел #${subject} больше не доступен. Обновите список.`);
		if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('Некорректные права сотрудника или отдела');
		const clean: Record<string, AccessV3Decision> = {};
		for (const [permission, decision] of Object.entries(rules)) {
			if (!permissions.has(permission) || (decision !== 'allow' && decision !== 'deny')) throw new Error(`Неизвестное право или значение: ${permission}`);
			clean[permission] = decision as AccessV3Decision;
		}
		if (Object.keys(clean).length) out[subject] = clean;
	}
	return out;
}
