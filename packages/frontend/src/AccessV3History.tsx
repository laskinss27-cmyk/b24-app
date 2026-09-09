import { useState } from 'react';
import { ACCESS_PERMISSIONS, type AccessV3Directory, type AccessV3Publication, type AccessV3PublicationStatus } from '@b24-app/shared';

export function publicationChanges(before: AccessV3Publication | undefined, after: AccessV3Publication) {
	const changes: { kind: 'departments' | 'employees'; id: string; permission: string; before: string; after: string }[] = [];
	for (const kind of ['departments', 'employees'] as const) {
		const oldRules = before?.active ? before[kind] : {};
		const newRules = after.active ? after[kind] : {};
		for (const id of new Set([...Object.keys(oldRules), ...Object.keys(newRules)])) {
			for (const permission of new Set([...Object.keys(oldRules[id] ?? {}), ...Object.keys(newRules[id] ?? {})])) {
				const oldValue = oldRules[id]?.[permission] ?? 'inherit';
				const newValue = newRules[id]?.[permission] ?? 'inherit';
				if (oldValue !== newValue) changes.push({ kind, id, permission, before: before ? oldValue : 'unknown', after: newValue });
			}
		}
	}
	return changes;
}
const label = (value: string, kind: string): string => value === 'allow' ? 'Разрешить' : value === 'deny' ? 'Запретить' : value === 'unknown' ? 'Нет предыдущей версии' : kind === 'employees' ? 'Без личного исключения' : 'Без правила отдела';

export function AccessV3History({ status, directory }: { status: AccessV3PublicationStatus; directory?: AccessV3Directory | undefined }): JSX.Element {
	const [all, setAll] = useState(false);
	const versions = [...new Map([...status.history, status.state].map(s => [s.revision, s])).values()].sort((a, b) => a.revision - b.revision);
	const entries = versions.map((state, index) => ({ state, before: versions[index - 1]?.revision === state.revision - 1 ? versions[index - 1] : undefined })).filter(e => e.state.revision > 0).reverse();
	const name = (kind: string, id: string): string => kind === 'employees' ? directory?.users.find(u => u.id === id)?.name ?? `Сотрудник #${id}` : directory?.departments.find(d => String(d.id) === id)?.name ?? `Отдел #${id}`;
	return <section aria-label="История применённых прав">
		<h3>История применённых прав</h3>
		<p>Только применение и отключение рабочих версий. Сохранение черновика и технические проверки сюда не попадают.</p>
		<small>Показаны изменения явных правил, не итог всех проверок доступа. Без личного исключения действует правило отдела, а без него — прежние проверки. Имена взяты из текущего справочника. Доступны последние сохранённые версии, не полный архив.</small>
		{!entries.length && <p>Рабочие права ещё не применялись.</p>}
		{(all ? entries : entries.slice(0, 5)).map(({ state, before }) => {
			const changes = publicationChanges(before, state);
			return <details key={state.revision}>
				<summary>Версия {state.revision} · {state.active ? 'Правила применены' : 'Правила отключены'} · {name('employees', String(state.updatedById))} · {state.updatedAt ? new Date(state.updatedAt).toLocaleString('ru-RU') : 'Время не указано'} · {before ? `изменений правил: ${changes.length}` : 'снимок правил'}</summary>
				{!before && <p>Предыдущая версия отсутствует в сохранённой истории. Показан снимок, состав изменений неизвестен.</p>}
				{!state.active && <p>Рабочие правила отключены. Снова действуют прежние проверки приложения; это не запрет всех прав.</p>}
				<div className="av3-preview-list">{changes.map(c => <div key={`${c.kind}:${c.id}:${c.permission}`}>
					<b>{c.kind === 'departments' ? 'Отдел' : 'Сотрудник'}: {name(c.kind, c.id)} · #{c.id}</b>
					<span>{ACCESS_PERMISSIONS.find(p => p.id === c.permission)?.label ?? c.permission}</span>
					<span>{label(c.before, c.kind)} → {label(c.after, c.kind)}</span>
				</div>)}</div>
				{before && !changes.length && <p>Состав явных правил не изменился.</p>}
			</details>;
		})}
		{entries.length > 5 && <button type="button" onClick={() => setAll(!all)}>{all ? 'Свернуть историю' : `Показать все сохранённые версии (${entries.length})`}</button>}
	</section>;
}
