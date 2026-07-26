import { useMemo, useState, useEffect } from 'react';
import {
	ACCESS_PERMISSIONS,
	ACCESS_PROFILES,
	effectiveDraftDecision,
	emptyAccessControlDraft,
	type AccessControlDraft,
	type AccessDecision,
	type AccessPermissionId,
	type AccessProfileId,
	type EmployeeAccessDraft,
} from '@b24-app/shared';
import {
	fetchAccessControlDraft,
	fetchAccessEmployees,
	isPortalAdmin,
	MANAGEMENT_USER_IDS,
	saveAccessControlDraft,
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

const MOCK_STORAGE_KEY = 'ud-access-control-draft-v1';

function cloneDraft(draft: AccessControlDraft): AccessControlDraft {
	return JSON.parse(JSON.stringify(draft)) as AccessControlDraft;
}

function employeeOrDefault(draft: AccessControlDraft, userId: string): EmployeeAccessDraft {
	return draft.employees[userId] ?? { profileId: 'legacy', overrides: {} };
}

function decisionLabel(decision: AccessDecision): string {
	return decision === 'allow' ? 'Разрешено' : decision === 'deny' ? 'Запрещено' : 'Текущие права';
}

function loadMockDraft(): AccessControlDraft {
	try {
		const raw = window.localStorage.getItem(MOCK_STORAGE_KEY);
		return raw ? JSON.parse(raw) as AccessControlDraft : emptyAccessControlDraft();
	} catch {
		return emptyAccessControlDraft();
	}
}

export function AccessControl({
	currentUserId,
	mock,
	onClose,
}: {
	currentUserId: string;
	mock: boolean;
	onClose: () => void;
}): JSX.Element {
	const allowed = mock || MANAGEMENT_USER_IDS.includes(currentUserId) || isPortalAdmin();
	const [draft, setDraft] = useState<AccessControlDraft | null>(null);
	const [users, setUsers] = useState<AccessEmployee[]>([]);
	const [selectedId, setSelectedId] = useState('');
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
			? Promise.resolve({ users: MOCK_USERS, draft: loadMockDraft() })
			: Promise.all([fetchAccessEmployees(), fetchAccessControlDraft()]).then(([loadedUsers, loadedDraft]) => ({
				users: loadedUsers,
				draft: loadedDraft,
			}));
		void load
			.then((result) => {
				setUsers(result.users);
				setDraft(result.draft);
				setSelectedId(result.users[0]?.id ?? '');
			})
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
			.finally(() => setBusy(false));
	}, [allowed, mock]);

	const groups = useMemo(() => ['Все', ...new Set(ACCESS_PERMISSIONS.map((item) => item.group))], []);
	const shownUsers = useMemo(() => {
		const words = search.trim().toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean);
		if (!words.length) return users;
		return users.filter((user) => {
			const haystack = `${user.name} ${user.position} ${user.id}`.toLocaleLowerCase('ru-RU');
			return words.every((word) => haystack.includes(word));
		});
	}, [search, users]);
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
	const selected = users.find((user) => user.id === selectedId) ?? null;
	const employee = draft && selected ? employeeOrDefault(draft, selected.id) : null;
	const configuredCount = draft ? Object.keys(draft.employees).length : 0;

	const patchEmployee = (patch: Partial<EmployeeAccessDraft>): void => {
		if (!draft || !selected) return;
		const next = cloneDraft(draft);
		next.employees[selected.id] = { ...employeeOrDefault(next, selected.id), ...patch };
		setDraft(next);
		setDirty(true);
		setNotice('');
	};

	const setOverride = (permissionId: AccessPermissionId, decision: AccessDecision): void => {
		if (!draft || !selected) return;
		const current = employeeOrDefault(draft, selected.id);
		const overrides = { ...current.overrides };
		if (decision === 'inherit') delete overrides[permissionId];
		else overrides[permissionId] = decision;
		patchEmployee({ overrides });
	};

	const resetEmployee = (): void => {
		if (!draft || !selected) return;
		const next = cloneDraft(draft);
		delete next.employees[selected.id];
		setDraft(next);
		setDirty(true);
		setNotice('');
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
					revision: draft.revision + 1,
					updatedAt: now,
					updatedById: currentUserId,
					updatedByName: 'Локальный руководитель',
					audit: [...draft.audit, {
						at: now,
						byId: currentUserId,
						byName: 'Локальный руководитель',
						changedUserIds: Object.keys(draft.employees),
					}].slice(-100),
				};
				window.localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(next));
				setDraft(next);
			} else {
				setDraft(await saveAccessControlDraft(draft));
			}
			setDirty(false);
			setNotice('Черновик сохранён. Действующие права сотрудников не изменились.');
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	if (!allowed) {
		return (
			<div className="access-control">
				<div className="access-denied">
					<h1>Доступ закрыт</h1>
					<p>Настройка прав доступна только руководству.</p>
					<button type="button" onClick={onClose}>Вернуться</button>
				</div>
			</div>
		);
	}

	return (
		<div className="access-control">
			<header className="access-header">
				<div>
					<div className="access-draft-badge">Черновик · не применяется</div>
					<h1>Права сотрудников</h1>
					<p>Можно подготовить будущие разрешения и запреты. Сейчас все сотрудники сохраняют свои прежние права.</p>
				</div>
				<div className="access-header-actions">
					<button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button>
					<button type="button" className="btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
						{busy ? 'Сохраняю…' : 'Сохранить черновик'}
					</button>
				</div>
			</header>

			<div className="access-safety">
				<strong>Новые правила выключены.</strong>
				<span>В этой версии нет кнопки включения, а рабочие разделы не читают этот черновик.</span>
			</div>
			{error && <div className="access-message error">{error}</div>}
			{notice && <div className="access-message ok">{notice}</div>}

			{busy && !draft ? <div className="access-loading">Загружаю сотрудников и черновик…</div> : (
				<div className="access-layout">
					<aside className="access-users">
						<div className="access-users-title">
							<strong>Сотрудники</strong>
							<span>{configuredCount} настроено</span>
						</div>
						<input
							type="search"
							value={search}
							placeholder="Имя, должность или ID"
							onChange={(event) => setSearch(event.target.value)}
						/>
						<div className="access-user-list">
							{shownUsers.map((user) => {
								const configured = Boolean(draft?.employees[user.id]);
								return (
									<button
										key={user.id}
										type="button"
										className={user.id === selectedId ? 'active' : ''}
										onClick={() => setSelectedId(user.id)}
									>
										<span className="access-avatar">{user.name.slice(0, 1).toUpperCase()}</span>
										<span className="access-user-text">
											<b>{user.name}</b>
											<small>{user.position || `ID ${user.id}`}</small>
										</span>
										{configured && <span className="access-configured" title="Есть настройки">●</span>}
									</button>
								);
							})}
						</div>
					</aside>

					<main className="access-editor">
						{selected && employee && draft ? (
							<>
								<section className="access-employee-head">
									<div>
										<h2>{selected.name}</h2>
										<p>{selected.position || 'Должность не указана'} · ID {selected.id}</p>
									</div>
									<button type="button" className="access-reset" onClick={resetEmployee}>Сбросить настройки</button>
								</section>

								<section className="access-profile">
									<label>
										<span>Базовый профиль</span>
										<select
											value={employee.profileId}
											onChange={(event) => patchEmployee({ profileId: event.target.value as AccessProfileId })}
										>
											{ACCESS_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
										</select>
									</label>
									<p>{ACCESS_PROFILES.find((profile) => profile.id === employee.profileId)?.description}</p>
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
										const explicit = employee.overrides[permission.id] ?? 'inherit';
										const effective = effectiveDraftDecision(employee, permission.id);
										return (
											<div className="access-permission-row" key={permission.id}>
												<div>
													<b>{permission.label}{'dangerous' in permission && permission.dangerous && <span className="access-risk">важное действие</span>}</b>
													<small>
														{explicit === 'inherit'
															? `Итог по профилю: ${decisionLabel(effective)}`
															: `Индивидуально: ${decisionLabel(explicit)}`}
													</small>
												</div>
												<div className="access-decision" role="group" aria-label={permission.label}>
													{([
														['inherit', 'По профилю'],
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
									<span>Примечание к сотруднику</span>
									<textarea
										rows={2}
										maxLength={500}
										value={employee.note ?? ''}
										placeholder="Например: временный доступ до конца месяца"
										onChange={(event) => patchEmployee({ note: event.target.value })}
									/>
								</label>
							</>
						) : <div className="access-empty">Выберите сотрудника слева.</div>}
					</main>
				</div>
			)}

			<footer className="access-footer">
				<span>Версия черновика: {draft?.revision ?? 0}</span>
				<span>{draft?.updatedAt ? `Последнее сохранение: ${new Date(draft.updatedAt).toLocaleString('ru-RU')} · ${draft.updatedByName ?? ''}` : 'Черновик ещё не сохранялся'}</span>
			</footer>
		</div>
	);
}
