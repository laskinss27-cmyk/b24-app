import { useEffect, useMemo, useState } from 'react';
import {
	ACCESS_PERMISSIONS,
	ACCESS_PROFILES,
	effectiveAccessDecision,
	effectiveDraftDecision,
	emptyAccessControlDraft,
	type AccessControlDraft,
	type AccessDecision,
	type AccessPermissionId,
	type AccessProfileId,
	type AccessSubjectRule,
} from '@b24-app/shared';
import {
	fetchAccessControlDraft,
	fetchAccessSubjects,
	saveAccessControlDraft,
	type AccessDepartment,
	type AccessEmployee,
} from './b24.js';

const MOCK_USERS: AccessEmployee[] = [
	{ id: '1', name: 'Дранишников Алексей', position: 'Руководитель', departments: [1] },
	{ id: '986', name: 'Бекасов Владимир', position: 'Руководитель', departments: [1] },
	{ id: '1858', name: 'Сергей', position: 'Администратор приложения', departments: [10] },
	{ id: '2101', name: 'Кузнецова Анна', position: 'Менеджер', departments: [3] },
	{ id: '2102', name: 'Морозов Илья', position: 'Снабжение', departments: [10] },
	{ id: '2103', name: 'Соколова Мария', position: 'Сервис', departments: [12] },
];
const MOCK_DEPARTMENTS: AccessDepartment[] = [
	{ id: 1, name: 'Руководство', memberCount: 2 },
	{ id: 3, name: 'Продажи', memberCount: 1 },
	{ id: 10, name: 'Снабжение', memberCount: 2 },
	{ id: 12, name: 'Сервисный центр', memberCount: 1 },
];

const MOCK_STORAGE_KEY = 'ud-access-control-draft-v2';

type AccessSubject =
	| { kind: 'department'; id: string; name: string; memberCount: number }
	| { kind: 'employee'; id: string; name: string; position: string; departments: number[] };

function subjectKey(subject: AccessSubject): string {
	return `${subject.kind}:${subject.id}`;
}

function cloneDraft(draft: AccessControlDraft): AccessControlDraft {
	return JSON.parse(JSON.stringify(draft)) as AccessControlDraft;
}

function ruleOrDefault(draft: AccessControlDraft, subject: AccessSubject): AccessSubjectRule {
	const rules = subject.kind === 'department' ? draft.departments : draft.employees;
	return rules[subject.id] ?? { profileId: 'legacy', overrides: {} };
}

function decisionLabel(decision: AccessDecision): string {
	return decision === 'allow' ? 'Разрешено' : decision === 'deny' ? 'Запрещено' : 'Сохраняются прежние права';
}

function employeesLabel(count: number): string {
	const mod100 = count % 100;
	const mod10 = count % 10;
	const word = mod100 >= 11 && mod100 <= 14
		? 'сотрудников'
		: mod10 === 1 ? 'сотрудник' : mod10 >= 2 && mod10 <= 4 ? 'сотрудника' : 'сотрудников';
	return `${count} ${word}`;
}

function loadMockDraft(): AccessControlDraft {
	try {
		const raw = window.localStorage.getItem(MOCK_STORAGE_KEY);
		if (!raw) return emptyAccessControlDraft();
		const parsed = JSON.parse(raw) as Partial<AccessControlDraft>;
		return {
			...emptyAccessControlDraft(),
			...parsed,
			version: 2,
			employees: parsed.employees ?? {},
			departments: parsed.departments ?? {},
		};
	} catch {
		return emptyAccessControlDraft();
	}
}

export function AccessControl({
	currentUserId,
	mock,
	canManageAccess,
	onClose,
}: {
	currentUserId: string;
	mock: boolean;
	canManageAccess: boolean;
	onClose: () => void;
}): JSX.Element {
	const allowed = mock || canManageAccess;
	const [draft, setDraft] = useState<AccessControlDraft | null>(null);
	const [users, setUsers] = useState<AccessEmployee[]>([]);
	const [departments, setDepartments] = useState<AccessDepartment[]>([]);
	const [selectedKey, setSelectedKey] = useState('');
	const [search, setSearch] = useState('');
	const [permissionSearch, setPermissionSearch] = useState('');
	const [group, setGroup] = useState('Все');
	const [busy, setBusy] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');

	useEffect(() => {
		if (!allowed) return;
		setBusy(true);
		const load = mock
			? Promise.resolve({ users: MOCK_USERS, departments: MOCK_DEPARTMENTS, draft: loadMockDraft() })
			: Promise.all([fetchAccessSubjects(), fetchAccessControlDraft()]).then(([subjects, loadedDraft]) => ({
				...subjects,
				draft: loadedDraft,
			}));
		void load
			.then((result) => {
				setUsers(result.users);
				setDepartments(result.departments);
				setDraft(result.draft);
				setSelectedKey(result.departments[0] ? `department:${result.departments[0].id}` : result.users[0] ? `employee:${result.users[0].id}` : '');
			})
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
			.finally(() => setBusy(false));
	}, [allowed, mock]);

	const subjects = useMemo<AccessSubject[]>(() => [
		...departments.map((department) => ({
			kind: 'department' as const,
			id: String(department.id),
			name: department.name,
			memberCount: department.memberCount,
		})),
		...users.map((user) => ({ kind: 'employee' as const, ...user })),
	], [departments, users]);
	const departmentNames = useMemo(
		() => new Map(departments.map((department) => [department.id, department.name])),
		[departments],
	);
	const groups = useMemo(() => ['Все', ...new Set(ACCESS_PERMISSIONS.map((item) => item.group))], []);
	const shownSubjects = useMemo(() => {
		const words = search.trim().toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean);
		if (!words.length) return subjects;
		return subjects.filter((subject) => {
			const departmentText = subject.kind === 'employee'
				? subject.departments.map((id) => departmentNames.get(id) ?? `Отдел ${id}`).join(' ')
				: 'отдел';
			const haystack = `${subject.name} ${subject.id} ${subject.kind === 'employee' ? subject.position : ''} ${departmentText}`
				.toLocaleLowerCase('ru-RU');
			return words.every((word) => haystack.includes(word));
		});
	}, [departmentNames, search, subjects]);
	const shownDepartments = shownSubjects.filter((subject) => subject.kind === 'department');
	const shownEmployees = shownSubjects.filter((subject) => subject.kind === 'employee');
	const shownPermissions = useMemo(() => {
		const query = permissionSearch.trim().toLocaleLowerCase('ru-RU');
		return ACCESS_PERMISSIONS.filter((item) => {
			if (group !== 'Все' && item.group !== group) return false;
			if (!query) return true;
			return `${item.label} ${item.group} ${item.id}`.toLocaleLowerCase('ru-RU').includes(query);
		});
	}, [group, permissionSearch]);
	const permissionCounts = useMemo(() => Object.fromEntries(
		groups.map((item) => [
			item,
			item === 'Все' ? ACCESS_PERMISSIONS.length : ACCESS_PERMISSIONS.filter((permission) => permission.group === item).length,
		]),
	), [groups]);
	const selected = subjects.find((subject) => subjectKey(subject) === selectedKey) ?? null;
	const selectedRule = draft && selected ? ruleOrDefault(draft, selected) : null;
	const configuredCount = draft ? Object.keys(draft.employees).length + Object.keys(draft.departments).length : 0;

	const patchRule = (patch: Partial<AccessSubjectRule>): void => {
		if (!draft || !selected) return;
		const next = cloneDraft(draft);
		const rules = selected.kind === 'department' ? next.departments : next.employees;
		rules[selected.id] = { ...ruleOrDefault(next, selected), ...patch };
		setDraft(next);
		setDirty(true);
		setNotice('');
	};

	const setOverride = (permissionId: AccessPermissionId, decision: AccessDecision): void => {
		if (!draft || !selected) return;
		const current = ruleOrDefault(draft, selected);
		const overrides = { ...current.overrides };
		if (decision === 'inherit') delete overrides[permissionId];
		else overrides[permissionId] = decision;
		patchRule({ overrides });
	};

	const resetSubject = (): void => {
		if (!draft || !selected) return;
		const next = cloneDraft(draft);
		if (selected.kind === 'department') delete next.departments[selected.id];
		else delete next.employees[selected.id];
		setDraft(next);
		setDirty(true);
		setNotice('');
	};

	const effectiveDecision = (permissionId: AccessPermissionId): AccessDecision => {
		if (!draft || !selected || !selectedRule) return 'inherit';
		if (selected.kind === 'department') return effectiveDraftDecision(selectedRule, permissionId);
		const inheritedDepartments = selected.departments.map((id) => draft.departments[String(id)]);
		return effectiveAccessDecision(selectedRule, inheritedDepartments, permissionId);
	};

	const save = async (): Promise<void> => {
		if (!draft || !dirty || busy) return;
		setBusy(true);
		setError('');
		try {
			if (mock) {
				const now = new Date().toISOString();
				const next: AccessControlDraft = {
					...draft,
					version: 2,
					revision: draft.revision + 1,
					policyMode: 'active',
					updatedAt: now,
					updatedById: currentUserId,
					updatedByName: 'Локальный администратор',
					audit: [...draft.audit, {
						at: now,
						byId: currentUserId,
						byName: 'Локальный администратор',
						changedUserIds: Object.keys(draft.employees),
						changedDepartmentIds: Object.keys(draft.departments),
					}].slice(-100),
				};
				window.localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(next));
				setDraft(next);
			} else {
				setDraft(await saveAccessControlDraft(draft));
			}
			setDirty(false);
			setNotice('Права сохранены и уже применяются в приложении.');
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const subjectButton = (subject: AccessSubject): JSX.Element => {
		const key = subjectKey(subject);
		const configured = Boolean(draft && (subject.kind === 'department' ? draft.departments[subject.id] : draft.employees[subject.id]));
		const subtitle = subject.kind === 'department'
			? employeesLabel(subject.memberCount)
			: [
				subject.position,
				subject.departments.map((id) => departmentNames.get(id) ?? `Отдел #${id}`).join(', '),
			].filter(Boolean).join(' · ') || `ID ${subject.id}`;
		return (
			<button key={key} type="button" className={key === selectedKey ? 'active' : ''} onClick={() => setSelectedKey(key)}>
				<span className={`access-avatar${subject.kind === 'department' ? ' department' : ''}`}>
					{subject.kind === 'department' ? 'О' : subject.name.slice(0, 1).toUpperCase()}
				</span>
				<span className="access-user-text">
					<b>{subject.name}</b>
					<small>{subtitle}</small>
				</span>
				{configured && <span className="access-configured" title="Есть настройки">●</span>}
			</button>
		);
	};

	if (!allowed) {
		return (
			<div className="access-control">
				<div className="access-denied">
					<h1>Доступ закрыт</h1>
					<p>Настройка прав доступна только руководству и администраторам приложения.</p>
					<button type="button" onClick={onClose}>Вернуться</button>
				</div>
			</div>
		);
	}

	return (
		<div className="access-control">
			<header className="access-header">
				<div>
					<div className={`access-draft-badge${draft?.policyMode === 'active' ? ' active' : ''}`}>
						{draft?.policyMode === 'active' ? 'Правила действуют' : 'Безопасный режим'}
					</div>
					<h1>Права сотрудников и отделов</h1>
					<p>Настройки отдела действуют на всех его сотрудников. Персональные настройки имеют приоритет.</p>
				</div>
				<div className="access-header-actions">
					<button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button>
					<button type="button" className="btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
						{busy ? 'Сохраняю…' : 'Сохранить права'}
					</button>
				</div>
			</header>

			<div className="access-safety">
				<strong>{draft?.policyMode === 'active' ? 'Настройки подключены.' : 'Пока действуют прежние права.'}</strong>
				<span>
					{draft?.policyMode === 'active'
						? 'Если сотрудник или его отдел не настроены, приложение оставляет их прежний доступ.'
						: 'Новая модель включится после первого сохранения. Ненастроенные сотрудники не будут заблокированы.'}
				</span>
			</div>
			{error && <div className="access-message error">{error}</div>}
			{notice && <div className="access-message ok">{notice}</div>}

			{busy && !draft ? <div className="access-loading">Загружаю сотрудников, отделы и права…</div> : (
				<div className="access-layout">
					<aside className="access-users">
						<div className="access-users-title">
							<strong>Кому настроить</strong>
							<span>{configuredCount} настроено</span>
						</div>
						<input
							type="search"
							value={search}
							placeholder="Отдел, имя, должность или ID"
							onChange={(event) => setSearch(event.target.value)}
						/>
						<div className="access-user-list">
							{shownDepartments.length > 0 && <div className="access-subject-heading">Отделы</div>}
							{shownDepartments.map(subjectButton)}
							{shownEmployees.length > 0 && <div className="access-subject-heading">Сотрудники</div>}
							{shownEmployees.map(subjectButton)}
							{shownSubjects.length === 0 && <div className="access-subject-empty">Ничего не найдено</div>}
						</div>
					</aside>

					<main className="access-editor">
						{selected && selectedRule && draft ? (
							<>
								<section className="access-employee-head">
									<div>
										<h2>{selected.kind === 'department' ? `Отдел «${selected.name}»` : selected.name}</h2>
										<p>
											{selected.kind === 'department'
												? `${employeesLabel(selected.memberCount)} · ID отдела ${selected.id}`
												: `${selected.position || 'Должность не указана'} · ID ${selected.id}`}
										</p>
									</div>
									<button type="button" className="access-reset" onClick={resetSubject}>Сбросить настройки</button>
								</section>

								<section className="access-profile">
									<label>
										<span>Базовый профиль</span>
										<select
											value={selectedRule.profileId}
											onChange={(event) => patchRule({ profileId: event.target.value as AccessProfileId })}
										>
											{ACCESS_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
										</select>
									</label>
									<p>{ACCESS_PROFILES.find((profile) => profile.id === selectedRule.profileId)?.description}</p>
								</section>

								<nav className="access-groups" aria-label="Разделы прав">
									{groups.map((item) => (
										<button key={item} type="button" className={group === item ? 'active' : ''} onClick={() => setGroup(item)}>
											{item}<span>{permissionCounts[item]}</span>
										</button>
									))}
								</nav>

								<div className="access-permission-tools">
									<input
										type="search"
										value={permissionSearch}
										placeholder="Найти право или действие"
										onChange={(event) => setPermissionSearch(event.target.value)}
									/>
									<span>Показано {shownPermissions.length} из {ACCESS_PERMISSIONS.length}</span>
								</div>

								<div className="access-permissions">
									{shownPermissions.map((permission) => {
										const explicit = selectedRule.overrides[permission.id] ?? 'inherit';
										const effective = effectiveDecision(permission.id);
										return (
											<div className="access-permission-row" key={permission.id}>
												<div>
													<b>
														{permission.label}
														{'dangerous' in permission && permission.dangerous && <span className="access-risk">важное действие</span>}
													</b>
													<small>
														{explicit === 'inherit'
															? `Итог с учётом наследования: ${decisionLabel(effective)}`
															: `Явно: ${decisionLabel(explicit)}`}
													</small>
												</div>
												<div className="access-decision" role="group" aria-label={permission.label}>
													{([
														['inherit', 'Наследовать'],
														['allow', 'Разрешить'],
														['deny', 'Запретить'],
													] as const).map(([value, label]) => (
														<button
															key={value}
															type="button"
															className={`${value}${explicit === value ? ' active' : ''}`}
															onClick={() => setOverride(permission.id, value)}
														>{label}</button>
													))}
												</div>
											</div>
										);
									})}
									{shownPermissions.length === 0 && (
										<div className="access-permissions-empty">По этому запросу права не найдены.</div>
									)}
								</div>

								<label className="access-note">
									<span>Примечание к {selected.kind === 'department' ? 'отделу' : 'сотруднику'}</span>
									<textarea
										rows={2}
										maxLength={500}
										value={selectedRule.note ?? ''}
										placeholder={selected.kind === 'department' ? 'Например: доступ для всего отдела продаж' : 'Например: временный доступ до конца месяца'}
										onChange={(event) => patchRule({ note: event.target.value })}
									/>
								</label>
							</>
						) : <div className="access-empty">Выберите отдел или сотрудника слева.</div>}
					</main>
				</div>
			)}

			<footer className="access-footer">
				<span>Версия настроек: {draft?.revision ?? 0}</span>
				<span>
					{draft?.updatedAt
						? `Последнее сохранение: ${new Date(draft.updatedAt).toLocaleString('ru-RU')} · ${draft.updatedByName ?? ''}`
						: 'Настройки ещё не сохранялись'}
				</span>
			</footer>
		</div>
	);
}
