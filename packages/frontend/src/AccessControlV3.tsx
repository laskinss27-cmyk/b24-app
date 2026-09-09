import { useEffect, useMemo, useState } from 'react';
import { accessV3Permissions, previewAccessV3, resolveAccessV3, type AccessV3Draft, type AccessV3Preview, type AccessV3Response, type AccessV3Value } from '@b24-app/shared';
import { accessV3Request, accessV3SaveInput } from './access-v3-api.js';
import { accessV3Demo } from './access-v3-demo.js';
import { AccessV3ShadowPanel } from './AccessV3ShadowPanel.js';
import { AccessV3PilotPanel } from './AccessV3PilotPanel.js';
import './access-v3.css';

const label = (value: AccessV3Value): string => value === 'allow' ? 'Разрешено' : value === 'deny' ? 'Запрещено' : 'Нужна проверка';

export function AccessControlV3({ mock, onClose, onDirtyChange }: { mock: boolean; onClose: () => void; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
	const [loaded, setLoaded] = useState<AccessV3Response | null>(null);
	const [draft, setDraft] = useState<AccessV3Draft | null>(null);
	const [selection, setSelection] = useState('');
	const [search, setSearch] = useState('');
	const [group, setGroup] = useState('Каталог');
	const [query, setQuery] = useState('');
	const [preview, setPreview] = useState<AccessV3Preview | null>(null);
	const [restore, setRestore] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [demoHistory, setDemoHistory] = useState<AccessV3Draft[]>([]);
	const accept = (data: AccessV3Response): void => { setLoaded(data);setDraft(structuredClone(data.draft));setPreview(null);setRestore(null); };
	useEffect(() => {
		let alive = true;setBusy(true);
		void (mock ? Promise.resolve(accessV3Demo()) : accessV3Request('load')).then(data => {
			if (!alive) return;accept(data);setSelection(data.directory.departments[0] ? `departments:${data.directory.departments[0].id}` : `employees:${data.directory.users[0]?.id ?? ''}`);
		}).catch(reason => { if (alive) setError(String(reason.message ?? reason)); }).finally(() => { if (alive) setBusy(false); });
		return () => { alive = false; };
	}, [mock]);
	const dirty = Boolean(draft && loaded && (JSON.stringify(draft.departments) !== JSON.stringify(loaded.draft.departments) || JSON.stringify(draft.employees) !== JSON.stringify(loaded.draft.employees)));
	useEffect(() => { onDirtyChange?.(dirty);return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
	useEffect(() => { const warn = (event: BeforeUnloadEvent): void => { if (dirty) { event.preventDefault();event.returnValue = ''; } };window.addEventListener('beforeunload', warn);return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
	const permissions = useMemo(() => accessV3Permissions(loaded?.directory.stores ?? []), [loaded?.directory.stores]);
	const groups = [...new Set(permissions.map(p => p.group))];
	const [kindRaw, id = ''] = selection.split(':');
	const kind = kindRaw === 'departments' ? 'departments' : 'employees';
	const person = loaded?.directory.users.find(u => u.id === id);
	const department = loaded?.directory.departments.find(d => String(d.id) === id);
	const title = kind === 'departments' ? department?.name : person?.name;
	const rules = draft?.[kind][id] ?? {};
	const update = (permissionId: string, value: 'inherit' | 'allow' | 'deny'): void => {
		if (!draft) return;const next = structuredClone(draft);const rule = next[kind][id] ?? {};
		if (value === 'inherit') delete rule[permissionId];else rule[permissionId] = value;
		if (Object.keys(rule).length) next[kind][id] = rule;else delete next[kind][id];
		setDraft(next);setPreview(null);setRestore(null);setNotice('');
	};
	const doPreview = async (revision: number | null = null): Promise<void> => {
		if (!draft || !loaded) return;setBusy(true);setError('');setPreview(null);setRestore(revision);
		try {
			if (mock) {
				const candidate = revision == null ? draft : demoHistory.find(d => d.revision === revision);
				if (!candidate) throw new Error('Версия не найдена');
				setPreview({ ...previewAccessV3(loaded.draft, candidate, loaded.directory), token: 'demo' });
			} else setPreview(await accessV3Request('preview', { ...accessV3SaveInput(draft, loaded.directory.fingerprint), ...(revision == null ? {} : { restoreRevision: revision }) }));
		} catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
	};
	const save = async (): Promise<void> => {
		if (!draft || !loaded || !preview) return;setBusy(true);setError('');
		try {
			if (mock) {
				const candidate = restore == null ? draft : demoHistory.find(d => d.revision === restore)!;
				const history = [...demoHistory, loaded.draft];setDemoHistory(history);
				accept({ ...loaded, draft: { ...candidate, revision: loaded.draft.revision + 1, mode: 'draft', updatedAt: new Date().toISOString(), updatedBy: 'Демо' }, history: history.map(d => ({ revision: d.revision, updatedAt: d.updatedAt, updatedBy: d.updatedBy })) });
			} else accept(await accessV3Request('save', { ...accessV3SaveInput(draft, loaded.directory.fingerprint), previewToken: preview.token, ...(restore == null ? {} : { restoreRevision: restore }) }));
			setNotice('Черновик сохранён. Рабочие права сотрудников не изменились.');
		} catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
	};
	const close = (): void => { if (!dirty || window.confirm('Закрыть без сохранения черновика?')) onClose(); };

	return <section className="access-v3" aria-label="Настройка прав отделов и сотрудников">
		<header className="av3-header"><div><span className="av3-badge">{mock ? 'ДЕМО · НЕ РЕАЛЬНЫЕ ПРАВА' : 'ЧЕРНОВИК · НЕ ВЛИЯЕТ НА РАБОТУ'}</span><h1>Права отделов и сотрудников</h1><p>База отдела → личные исключения → предварительная проверка</p></div><button type="button" onClick={close}>Закрыть</button></header>
		<div className="av3-safety"><b>Сохранение черновика не меняет рабочие права.</b> Для владельца можно отдельно включить сохранённую версию узкого пилота просмотра закупки. Её статус показан ниже. Остальные настройки остаются черновиком. Ограничения Битрикса сохраняются; «Нужна проверка» не подтверждает доступ во всех сценариях.</div>
		{error && <div role="alert" className="av3-error">{error}</div>}{notice && <div role="status" className="av3-notice">{notice}</div>}
		{loaded && <AccessV3ShadowPanel initial={loaded.shadow} mock={mock} />}
		{loaded && <AccessV3PilotPanel mock={mock} dirty={dirty || busy} savedRevision={loaded.draft.revision} />}
		{loaded && draft && draft.baseline.directoryFingerprint !== loaded.directory.fingerprint && <div role="alert" className="av3-scope-note">Справочник сотрудников, отделов или складов изменился после создания базы. Оценки наследования основаны на прежнем снимке и требуют повторной сверки. Черновик не является подтверждением текущего доступа.</div>}
		{!loaded || !draft ? <p>{busy ? 'Загружаю полный справочник сотрудников, отделов и складов…' : 'Не удалось загрузить настройки. Закройте и откройте окно повторно.'}</p> : <>
			<div className="av3-layout"><aside className="av3-subjects"><label>Найти отдел или сотрудника<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Имя или отдел" /></label>
				<h3>Отделы · базовые права</h3>{loaded.directory.departments.filter(d => d.name.toLowerCase().includes(search.toLowerCase())).map(d => <button type="button" key={d.id} className={selection === `departments:${d.id}` ? 'selected' : ''} onClick={() => setSelection(`departments:${d.id}`)}>{d.name}<small>{loaded.directory.users.filter(u => u.departments.includes(d.id)).length} сотрудников · {Object.keys(draft.departments[String(d.id)] ?? {}).length} изменений</small></button>)}
				<h3>Сотрудники · исключения</h3>{loaded.directory.users.filter(u => `${u.name} ${u.departments.map(id => loaded.directory.departments.find(d => d.id === id)?.name).join(' ')}`.toLowerCase().includes(search.toLowerCase())).map(u => <button type="button" key={u.id} className={selection === `employees:${u.id}` ? 'selected' : ''} onClick={() => setSelection(`employees:${u.id}`)}>{u.name}<small>{u.departments.map(id => loaded.directory.departments.find(d => d.id === id)?.name ?? `#${id}`).join(', ') || 'Без отдела'} · {Object.keys(draft.employees[u.id] ?? {}).length} исключений</small></button>)}
			</aside><main className="av3-editor"><h2>{title ?? 'Выберите сотрудника или отдел'}</h2><p>{kind === 'departments' ? 'Изменения наследуют сотрудники отдела без личного исключения.' : '«Как у отдела» убирает личное исключение. Личное разрешение или запрет сильнее отдела.'}</p>
				<div className="av3-toolbar"><label>Раздел<select value={group} onChange={e => setGroup(e.target.value)}>{groups.map(g => <option key={g}>{g}</option>)}</select></label><label>Найти действие<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Например, закупочные цены" /></label></div>
				{group === 'Доступ по складам' && <p className="av3-scope-note">Допуск к складу — отдельное ограничение, он не заменяет право на саму операцию. Эти переключатели пока только в черновике.</p>}
				{permissions.filter(p => p.group === group && p.label.toLowerCase().includes(query.toLowerCase())).map(p => {
					const explicit = rules[p.id];const base = draft.baseline.departments[id]?.[p.id];
					const resolved = kind === 'employees' && person ? resolveAccessV3(draft, person, p.id, loaded.directory) : { value: explicit ?? base?.value ?? 'context', source: explicit ? 'Настройка отдела' : base?.reason ?? 'Требует проверки', conflict: false };
					return <div className="av3-permission" key={p.id}><div><b>{p.label}</b><span className={`av3-result ${resolved.value}`}>{label(resolved.value)} в проекте правил</span><small>{resolved.source}{resolved.conflict ? ' · Конфликт отделов: действует запрет' : ''}</small></div><div className="av3-switch" role="group" aria-label={p.label}>{(['inherit', 'allow', 'deny'] as const).map(value => <button type="button" key={value} disabled={busy || !title} aria-pressed={(explicit ?? 'inherit') === value} onClick={() => update(p.id, value)}>{value === 'inherit' ? kind === 'departments' ? 'Текущая база' : 'Как у отдела' : value === 'allow' ? 'Разрешить' : 'Запретить'}</button>)}</div></div>;
				})}
			</main></div>
			<footer className="av3-footer"><div>Версия {draft.revision} · База: {new Date(draft.baseline.capturedAt).toLocaleString('ru-RU')}<small>{draft.updatedBy ? `Сохранено: ${draft.updatedBy}` : 'Персональные исключения из текущего кода сохранены в базе'}</small></div><button type="button" disabled={busy || !dirty} onClick={() => void doPreview()}>Проверить изменения</button></footer>
			{preview && <section className="av3-preview" aria-label="Предварительный просмотр изменений"><h2>{restore == null ? 'Что изменится в проекте правил' : `Возврат к черновику версии ${restore}`}</h2><p>{preview.changedRules} настроек · {preview.changedUsers} сотрудников · {preview.changes.length} изменений доступа. Рабочие права пока не меняются.</p><div className="av3-preview-list">{preview.changes.slice(0, 100).map(c => <div key={`${c.userId}:${c.permissionId}`}><b>{c.name}</b><span>{c.label}</span><span>{label(c.before.value)} → {label(c.after.value)}</span><small>{c.after.source}</small></div>)}</div>{preview.changes.length > 100 && <p>Показаны первые 100 из {preview.changes.length} изменений.</p>}{!preview.changes.length && <p>Итоговый доступ не изменится. Могут измениться источник наследования или настройки для будущих сотрудников.</p>}<button type="button" disabled={busy} onClick={() => void save()}>Сохранить только черновик</button><button type="button" disabled={busy} onClick={() => { setPreview(null);setRestore(null); }}>Вернуться к редактированию</button></section>}
			<details className="av3-history"><summary>История черновиков и откат ({loaded.history.length})</summary>{loaded.history.slice().reverse().map(h => <div key={h.revision}>Версия {h.revision} · {h.updatedBy ?? 'Исходная'} · {h.updatedAt ? new Date(h.updatedAt).toLocaleString('ru-RU') : '—'} <button type="button" disabled={busy || dirty} onClick={() => void doPreview(h.revision)}>Посмотреть откат</button></div>)}</details>
		</>}
	</section>;
}
