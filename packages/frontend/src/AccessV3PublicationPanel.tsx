import { useEffect, useState } from 'react';
import { ACCESS_PERMISSIONS, type AccessV3PublicationPreview, type AccessV3PublicationStatus } from '@b24-app/shared';
import { bx24Auth } from './bitrix-auth.js';

export async function requestPublication<T>(action: 'status' | 'preview' | 'activate' | 'disable', data: Record<string, unknown> = {}): Promise<T> {
	const response = await fetch(`/api/access-control/v3/publication/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bx24Auth(), ...data }) });
	const result = await response.json();
	if (!response.ok || result.ok !== true) throw new Error(result.error ?? 'Не удалось проверить рабочие права.');
	return result;
}
const decision = (value: string): string => value === 'allow' ? 'Разрешить' : value === 'deny' ? 'Запретить' : 'Прежние правила';
export function AccessV3PublicationPanel({ mock, dirty, savedRevision }: { mock: boolean; dirty: boolean; savedRevision: number }): JSX.Element {
	const [status, setStatus] = useState<AccessV3PublicationStatus | null>(null);
	const [preview, setPreview] = useState<AccessV3PublicationPreview | null>(null);
	const [busy, setBusy] = useState(false), [error, setError] = useState('');
	useEffect(() => {
		let alive = true; setPreview(null);
		if (!mock) void requestPublication<AccessV3PublicationStatus>('status').then(s => { if (alive) setStatus(s); }).catch(e => { if (alive) setError(String(e.message)); });
		return () => { alive = false; };
	}, [mock, savedRevision]);
	useEffect(() => { if (dirty) setPreview(null); }, [dirty]);
	const run = async (action: 'status' | 'preview' | 'activate' | 'disable'): Promise<void> => {
		setBusy(true); setError('');
		try {
			if (action === 'preview') {
				const p = await requestPublication<AccessV3PublicationPreview>('preview');
				if (dirty || p.draftRevision !== savedRevision) throw new Error('Сохраните изменения и обновите редактор перед применением.');
				setPreview(p);
			} else {
				if (action === 'activate' && (!preview || dirty)) throw new Error('Сначала проверьте применение сохранённого черновика.');
				setStatus(await requestPublication<AccessV3PublicationStatus>(action, action === 'activate' ? { previewToken: preview!.token, revision: preview!.revision, draftRevision: preview!.draftRevision, directoryFingerprint: preview!.directoryFingerprint } : {}));
				setPreview(null);
			}
		} catch (e) { setError(e instanceof Error ? e.message : String(e)); setPreview(null); }
		finally { setBusy(false); }
	};
	return <section className="av3-preview" aria-label="Рабочие права отделов и сотрудников">
		<h2>Рабочие права отделов и сотрудников</h2>
		<p>Подключены три права каталога: просмотр закупки, изменение розничной цены, изменение закупочной цены. Другие разделы и складские допуски остаются черновиком.</p>
		<p>Личное исключение сильнее отдела. Без явного правила действуют прежние проверки. Состав отделов проверяется на каждом запросе. Скрытую закупку редактировать нельзя. Создание новых товаров и их начальные цены — по прежним правам.</p>
		<p>Это права каталога, не скрытие закупки во всей программе: сделки, складские документы и отчёты подключаются отдельно. Доступ владельца к конфигуратору защищён.</p>
		{mock ? <p>В демо рабочие права не применяются.</p> : <>
			{error && <p role="alert" className="av3-error">{error}</p>}
			<p role="status">{status ? status.state.active ? `Включена рабочая версия ${status.state.revision}, черновик ${status.state.draftRevision}. Обновите каталог после изменения прав.` : 'Рабочие правила отделов выключены. Действуют прежние права или отдельно включённый узкий пилот.' : 'Статус рабочих прав не загружен.'}</p>
			<button type="button" disabled={busy} onClick={() => void run('status')}>Обновить статус рабочих прав</button>
			{status?.canActivate && <>
				<button type="button" disabled={busy || dirty || savedRevision < 1} onClick={() => void run('preview')}>Проверить применение прав каталога</button>
				<button type="button" disabled={busy || savedRevision < 1} onClick={() => { if (window.confirm('Отключить рабочие правила каталога для всех сотрудников и вернуть прежние проверки? Черновик сохранится.')) void run('disable'); }}>Отключить рабочие правила каталога</button>
				{dirty && <p>Сначала сохраните черновик. Отключение доступно без сохранения.</p>}
				{preview && <div className="av3-scope-note"><h3>Подтверждение рабочей версии</h3>
					<p>Черновик {preview.draftRevision}: {preview.ruleCount} правил, {new Set(preview.changes.map(c => c.userId)).size} сотрудников с изменением явного правила. {preview.ignoredRules} настроек других действий не применяются.</p>
					<p>«Прежние правила» — живая проверка приложения, не исторический снимок. Разрешение не отменяет требования к документам и доступ Битрикса. Правила отделов действуют и для будущих сотрудников этих отделов.</p>
					<div className="av3-preview-list">{preview.changes.map(c => <div key={`${c.userId}:${c.permissionId}`}><b>{c.name} · #{c.userId}</b><span>{ACCESS_PERMISSIONS.find(p => p.id === c.permissionId)?.label ?? c.permissionId}</span><span>{decision(c.before)} → {decision(c.after)}</span><small>{c.source}</small></div>)}</div>
					{!preview.changes.length && <p>Для текущих сотрудников явные правила не изменятся.</p>}
					<button type="button" disabled={busy || dirty} onClick={() => void run('activate')}>Подтверждаю применение этих прав каталога</button>
				</div>}
			</>}
			{status && !status.canActivate && <p>Применение и отключение доступны только владельцу.</p>}
			{status && <details><summary>История рабочих версий</summary>{[...status.history, status.state].filter(s => s.revision > 0).reverse().map(s => <p key={s.revision}>Версия {s.revision}: {s.active ? `включена из черновика ${s.draftRevision}` : 'отключена'} · #{s.updatedById} · {s.updatedAt ? new Date(s.updatedAt).toLocaleString('ru-RU') : ''}</p>)}</details>}
		</>}
	</section>;
}
