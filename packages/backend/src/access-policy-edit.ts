import { ACCESS_ROLE_OWNER_IDS, canGrantAdministrator, effectiveDraftDecision, type AccessControlDraft, type AccessSubjectRule } from '@b24-app/shared';

export function changedSubjects(before: Record<string, AccessSubjectRule>, after: Record<string, AccessSubjectRule>): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((id) => JSON.stringify(before[id] ?? null) !== JSON.stringify(after[id] ?? null));
}

function privileged(rule: AccessSubjectRule | undefined): boolean {
	return rule?.profileId === 'administrator' || effectiveDraftDecision(rule, 'admin.manage_access') === 'allow'
		|| effectiveDraftDecision(rule, 'admin.manage_profiles') === 'allow';
}

/** Проверяется на сервере, включая скрытые поля и удаление существующих назначений. */
export function accessPolicyEditError(actorId: string, current: AccessControlDraft, employees: Record<string, AccessSubjectRule>, departments: Record<string, AccessSubjectRule>): string | null {
	if (Object.values(departments).some(privileged)) {
		return 'Администратора и право управления доступом можно назначить только конкретному сотруднику, не отделу.';
	}
	for (const id of ACCESS_ROLE_OWNER_IDS) {
		const rule = employees[id];
		if (rule?.profileId !== 'administrator' || Object.keys(rule.overrides).length) {
			return 'Администраторы Сергей и Владимир Дранишников закреплены в системе; изменить их доступ нельзя.';
		}
	}
	if (!canGrantAdministrator(actorId)) {
		for (const id of changedSubjects(current.employees, employees)) {
			if (privileged(current.employees[id]) || privileged(employees[id]) || canGrantAdministrator(id)) {
				return 'Назначать администраторов и менять их доступ могут только Сергей и Владимир Дранишников.';
			}
		}
	}
	return null;
}

// Один backend обслуживает политику портала. Повторно читаем revision внутри
// очереди, чтобы два одновременных сохранения не затёрли друг друга.
const saves = new Map<string, Promise<void>>();
export async function withAccessPolicySave<T>(domain: string, operation: () => Promise<T>): Promise<T> {
	const previous = saves.get(domain) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((resolve) => { release = resolve; });
	saves.set(domain, next);
	await previous;
	try { return await operation(); }
	finally { release(); if (saves.get(domain) === next) saves.delete(domain); }
}
