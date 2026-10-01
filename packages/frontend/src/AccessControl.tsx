import { useEffect, useState } from 'react';
import {
	WAREHOUSE_PERMISSIONS as ACCESS_PERMISSIONS, ACCESS_PROFILES, ACCESS_ROLE_OWNER_IDS, canGrantAdministrator,
	effectiveAccessDecision, effectiveDraftDecision, emptyAccessControlDraft,
	type AccessControlDraft, type AccessDecision, type AccessPermissionId, type AccessProfileId, type AccessSubjectRule,
} from '@b24-app/shared';
import { fetchAccessControlDraft, fetchAccessSubjects, saveAccessControlDraft, type AccessDepartment, type AccessEmployee } from './access-control-api.js';

const MOCK_USERS: AccessEmployee[] = [
	{ id: '1', name: 'Дранишников Владимир', position: 'Администратор', departments: [1] },
	{ id: '1858', name: 'Сергей', position: 'Администратор', departments: [1] },
	{ id: '2101', name: 'Кузнецова Анна', position: 'Менеджер', departments: [3] },
	{ id: '2102', name: 'Морозов Илья', position: 'Специалист по закупкам', departments: [10] },
	{ id: '2103', name: 'Соколова Мария', position: 'Менеджер', departments: [3] },
];
const MOCK_DEPARTMENTS: AccessDepartment[] = [
	{ id: 3, name: 'Продажи', memberCount: 2 }, { id: 10, name: 'Снабжение', memberCount: 1 }, { id: 1, name: 'Руководство', memberCount: 2 },
];
const MOCK_KEY = 'ud-access-control-live-preview-v1';
type Subject = { kind: 'department'; id: string; name: string; memberCount: number } | ({ kind: 'employee' } & AccessEmployee);
const keyOf = (subject: Subject): string => `${subject.kind}:${subject.id}`;
const rulesOf = (draft: AccessControlDraft, subject: Subject): Record<string, AccessSubjectRule> => subject.kind === 'department' ? draft.departments : draft.employees;
const ruleOf = (draft: AccessControlDraft, subject: Subject): AccessSubjectRule => rulesOf(draft, subject)[subject.id] ?? { profileId: 'legacy', overrides: {} };
const decisionLabel = (decision: AccessDecision): string => decision === 'allow' ? 'Разрешено' : decision === 'deny' ? 'Запрещено' : 'По прежним правилам';
function mockDraft(): AccessControlDraft {
	let draft = emptyAccessControlDraft();
	try { const raw = localStorage.getItem(MOCK_KEY); if (raw) draft = JSON.parse(raw) as AccessControlDraft; } catch { /* Empty preview. */ }
	for (const id of ACCESS_ROLE_OWNER_IDS) draft.employees[id] = { profileId: 'administrator', overrides: {} };
	return draft;
}

export function AccessControl({ currentUserId, mock, canManageAccess, onClose }: {
	currentUserId: string; mock: boolean; canManageAccess: boolean; onClose: () => void;
}): JSX.Element {
	const [draft, setDraft] = useState<AccessControlDraft | null>(null);
	const [saved, setSaved] = useState<AccessControlDraft | null>(null);
	const [users, setUsers] = useState<AccessEmployee[]>([]);
	const [departments, setDepartments] = useState<AccessDepartment[]>([]);
	const [kind, setKind] = useState<'department' | 'employee'>('department');
	const [selection, setSelection] = useState('');
	const [search, setSearch] = useState('');
	const [advanced, setAdvanced] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [reload, setReload] = useState(0);
	const allowed = mock || canManageAccess;
	const grantAdmin = canGrantAdministrator(currentUserId);
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	useEffect(() => {
		if (!allowed) return;
		let alive = true; setBusy(true); setError('');
		const load = mock ? Promise.resolve({ users: MOCK_USERS, departments: MOCK_DEPARTMENTS, draft: mockDraft() })
			: Promise.all([fetchAccessSubjects(), fetchAccessControlDraft()]).then(([subjects, next]) => ({ ...subjects, draft: next }));
		void load.then((result) => {
			if (!alive) return;
			setUsers(result.users); setDepartments(result.departments); setDraft(result.draft); setSaved(result.draft);
			setSelection(result.departments[0] ? `department:${result.departments[0].id}` : ''); setKind('department'); setNotice('');
		}).catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); })
			.finally(() => { if (alive) setBusy(false); });
		return () => { alive = false; };
	}, [allowed, mock, reload]);
	useEffect(() => {
		if (!dirty) return;
		const prevent = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
		window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
	}, [dirty]);
	const subjects: Subject[] = [
		...departments.map((department) => ({ ...department, id: String(department.id), kind: 'department' as const })),
		...users.map((user) => ({ ...user, kind: 'employee' as const })),
	];
	const names = new Map(departments.map((department) => [department.id, department.name]));
	const selected = subjects.find((subject) => keyOf(subject) === selection);
	const rule = draft && selected ? ruleOf(draft, selected) : null;
	const founder = selected?.kind === 'employee' && canGrantAdministrator(selected.id);
	const protectedRule = rule?.profileId === 'administrator' || effectiveDraftDecision(rule ?? undefined, 'admin.manage_access') === 'allow';
	const readOnly = busy || Boolean(founder) || (protectedRule && !grantAdmin);
	const shown = subjects.filter((subject) => subject.kind === kind && search.toLocaleLowerCase('ru').split(/\s+/).every((word) =>
		`${subject.name} ${subject.id} ${subject.kind === 'employee' ? `${subject.position} ${subject.departments.map((id) => names.get(id)).join(' ')}` : ''}`.toLocaleLowerCase('ru').includes(word)));
	const groups = [...new Set(ACCESS_PERMISSIONS.map((permission) => permission.group))];
	const affected = draft && saved ? subjects.filter((subject) => JSON.stringify(rulesOf(draft, subject)[subject.id]) !== JSON.stringify(rulesOf(saved, subject)[subject.id])) : [];
	const change = (patch: Partial<AccessSubjectRule>): void => {
		if (!draft || !selected || readOnly) return;
		const next = structuredClone(draft); rulesOf(next, selected)[selected.id] = { ...ruleOf(next, selected), ...patch };
		setDraft(next); setNotice('');
	};
	const effective = (permissionId: AccessPermissionId): AccessDecision => {
		if (!selected || !draft) return 'inherit';
		return selected.kind === 'department' ? effectiveDraftDecision(rule ?? undefined, permissionId)
			: effectiveAccessDecision(rule ?? undefined, selected.departments.map((id) => draft.departments[String(id)]), permissionId);
	};
	const reset = (): void => {
		if (!draft || !selected || readOnly) return;
		const next = structuredClone(draft); delete rulesOf(next, selected)[selected.id]; setDraft(next); setNotice('');
	};
	const discardOK = (): boolean => !dirty || window.confirm('Изменения ещё не сохранены. Отменить их?');
	const save = async (): Promise<void> => {
		if (!draft || busy || !dirty) return;
		setBusy(true); setError(''); setNotice('');
		try {
			const next = mock ? { ...draft, policyMode: 'active' as const, revision: draft.revision + 1,
				updatedAt: new Date().toISOString(), updatedById: currentUserId, updatedByName: 'Локальный администратор' } : await saveAccessControlDraft(draft);
			if (mock) localStorage.setItem(MOCK_KEY, JSON.stringify(next));
			setDraft(next); setSaved(next); setNotice(mock ? 'Настройки сохранены в демонстрации.' : 'Права сохранены. В открытых окнах сотрудников изменения применятся после обновления страницы.');
		} catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
		finally { setBusy(false); }
	};
	if (!allowed) return <div className="access-control"><h1>Доступ закрыт</h1><p>Настраивать права могут администраторы приложения.</p><button onClick={onClose}>Вернуться</button></div>;
	return <div className="access-control">
		<header className="access-header"><div><p className="access-eyebrow">Складской учёт · права доступа</p><h1>Сотрудники и отделы</h1><p>Выберите базовую роль. При необходимости настройте отдельные действия.</p></div>
			<button disabled={busy} onClick={() => { if (discardOK()) onClose(); }}>Вернуться к складу</button></header>
		{error && <div role="alert" className="access-message error">{error} <button disabled={busy} onClick={() => { if (discardOK()) setReload((value) => value + 1); }}>Загрузить актуальные права</button></div>}
		{notice && <div role="status" className="access-message ok">{notice}</div>}
		{busy && !draft && <p role="status">Загружаю сотрудников и права…</p>}
		{draft && <div className="access-layout">
			<aside className="access-users" aria-label="Выбор сотрудника или отдела">
				<div className="access-subject-tabs" role="group" aria-label="Кому настроить доступ">{(['department', 'employee'] as const).map((value) =>
					<button key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setSearch(''); const first = subjects.find((subject) => subject.kind === value); setSelection(first ? keyOf(first) : ''); setAdvanced(false); }}>{value === 'department' ? 'Отделы' : 'Сотрудники'}</button>)}</div>
				<label className="access-search">{kind === 'department' ? 'Найти отдел' : 'Найти сотрудника'}<input type="search" value={search} placeholder={kind === 'department' ? 'Название отдела' : 'Имя, должность или отдел'} onChange={(event) => setSearch(event.target.value)} /></label>
				<div className="access-user-list">{shown.map((subject) => {
					const subjectRule = ruleOf(draft, subject);
					return <button key={keyOf(subject)} aria-pressed={selection === keyOf(subject)} onClick={() => { setSelection(keyOf(subject)); setAdvanced(false); }}>
						<strong>{subject.name}</strong><span>{subject.kind === 'department' ? `Сотрудников: ${subject.memberCount}` : subject.position || `ID ${subject.id}`}</span>
						<small>{ACCESS_PROFILES.find((profile) => profile.id === subjectRule.profileId)?.label}{Object.keys(subjectRule.overrides).length ? ' · настроено' : ''}</small></button>;
				})}{!shown.length && <p className="access-empty">Ничего не найдено</p>}</div>
			</aside>
			<main className="access-editor">{selected && rule ? <>
				<div className="access-subject-head"><p className="access-eyebrow">{selected.kind === 'department' ? 'Доступ отдела' : 'Личный доступ'}</p><h2>{selected.name}</h2>
					<p>{selected.kind === 'department' ? `Сотрудников: ${selected.memberCount}. Настройки действуют на прямых участников отдела, включая новых.` : selected.departments.map((id) => names.get(id) ?? `Отдел #${id}`).join(' · ') || 'Отдел не указан'}</p></div>
				{founder ? <div className="access-fixed"><strong>Администратор</strong><p>Роль закреплена за Сергеем и Владимиром Дранишниковым. Только они могут назначать других администраторов.</p></div> : <>
					<label className="access-role-label">Базовая роль<select value={rule.profileId} disabled={readOnly} onChange={(event) => {
						if (Object.keys(rule.overrides).length && !window.confirm('Применить новую роль и убрать индивидуальные изменения действий?')) return;
						change({ profileId: event.target.value as AccessProfileId, overrides: {} });
					}}>{ACCESS_PROFILES.filter((profile) => profile.id !== 'administrator' || (selected.kind === 'employee' && (grantAdmin || rule.profileId === 'administrator'))).map((profile) => <option key={profile.id} value={profile.id}>{profile.id === 'legacy' && selected.kind === 'department' ? 'Прежние права' : profile.label}</option>)}</select></label>
					<p className="access-role-description">{ACCESS_PROFILES.find((profile) => profile.id === rule.profileId)?.description}</p>
					{selected.kind === 'department' && <p className="access-hint">Личные настройки сотрудника имеют приоритет. Администратор назначается только человеку.</p>}
					{selected.kind === 'employee' && rule.profileId === 'legacy' && <p className="access-hint">Если отделов несколько, запрет одного из них имеет приоритет над разрешением другого.</p>}
				</>}
				<div className="access-summary">{groups.map((group) => {
					const items = ACCESS_PERMISSIONS.filter((permission) => permission.group === group);
					const permitted = items.filter((permission) => effective(permission.id) === 'allow').length;
					const inherited = items.some((permission) => effective(permission.id) === 'inherit');
					return <div key={group}><span>{group}</span><strong>{inherited ? 'По прежним правилам' : permitted === items.length ? 'Все действия' : permitted ? `${permitted} из ${items.length}` : 'Нет доступа'}</strong></div>;
				})}</div>
				{!founder && <div className="access-custom-actions"><button aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? 'Скрыть действия' : 'Настроить отдельные действия'}{Object.keys(rule.overrides).length > 0 ? ` (${Object.keys(rule.overrides).length})` : ''}</button><button disabled={readOnly} onClick={reset}>{selected.kind === 'department' ? 'Убрать настройки отдела' : 'Убрать личные настройки'}</button></div>}
				{advanced && <section className="access-advanced" aria-label="Отдельные действия">{groups.map((group) => <details key={`${selection}:${group}`}>
					<summary>{group}</summary>{ACCESS_PERMISSIONS.filter((permission) => permission.group === group).map((permission) => {
						const locked = readOnly || rule.profileId === 'administrator' || (permission.id.startsWith('admin.') && (!grantAdmin || selected.kind === 'department'));
						return <label className="access-permission" key={permission.id}><span>{permission.label}<small>{decisionLabel(effective(permission.id))}</small></span>
							<select disabled={locked} value={rule.overrides[permission.id] ?? 'inherit'} onChange={(event) => {
								const overrides = { ...rule.overrides }; const value = event.target.value as AccessDecision;
								if (value === 'inherit') delete overrides[permission.id]; else overrides[permission.id] = value;
								change({ overrides });
							}}><option value="inherit">По базовой роли</option><option value="allow">Разрешить</option><option value="deny">Запретить</option></select></label>;
					})}</details>)}</section>}
				{!founder && <label className="access-note">Примечание · необязательно<textarea disabled={readOnly} maxLength={500} rows={2} value={rule.note ?? ''} onChange={(event) => change({ note: event.target.value })} /></label>}
			</> : <p className="access-empty">Выберите отдел или сотрудника.</p>}</main>
		</div>}
		<footer className="access-save-bar"><div aria-live="polite"><strong>{dirty ? `Есть изменения: ${affected.length}` : 'Нет несохранённых изменений'}</strong><small>{dirty ? affected.map((subject) => subject.name).join(', ') : saved?.updatedAt ? `Сохранено ${new Date(saved.updatedAt).toLocaleString('ru-RU')} · ${saved.updatedByName ?? ''}` : 'Сотрудники сохраняют прежние права до назначения роли.'}</small></div><button className="btn-primary" disabled={!dirty || busy} onClick={() => void save()}>{busy && draft ? 'Сохраняю…' : 'Сохранить изменения'}</button></footer>
		{draft && draft.audit.length > 0 && <details className="access-audit"><summary>История изменений</summary>{[...draft.audit].reverse().map((entry, index) => <p key={`${entry.at}:${index}`}>{new Date(entry.at).toLocaleString('ru-RU')} · {entry.byName} · сотрудников: {entry.changedUserIds.length}, отделов: {entry.changedDepartmentIds?.length ?? 0}</p>)}</details>}
	</div>;
}
