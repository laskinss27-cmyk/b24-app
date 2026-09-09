import { useEffect, useState } from 'react';
import type { AccessV3PilotPreview, AccessV3PilotStatus } from '@b24-app/shared';
import { bx24Auth } from './bitrix-auth.js';

export async function requestPilot<T>(action: 'status' | 'preview' | 'activate' | 'disable', data: Record<string, unknown> = {}): Promise<T> {
	const response = await fetch(`/api/access-control/v3/pilot/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bx24Auth(), ...data }) });
	const result = await response.json();if (!response.ok || result.ok !== true) throw new Error(result.error ?? 'Не удалось проверить пилот.');
	return result;
}

export function AccessV3PilotPanel({ mock, dirty, savedRevision }: { mock: boolean; dirty: boolean; savedRevision: number }): JSX.Element {
	const [status, setStatus] = useState<AccessV3PilotStatus | null>(null);
	const [preview, setPreview] = useState<AccessV3PilotPreview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	useEffect(() => {
		let alive = true;setPreview(null);
		if (!mock) void requestPilot<AccessV3PilotStatus>('status').then(value => { if (alive) setStatus(value); }).catch(reason => { if (alive) setError(String(reason.message)); });
		return () => { alive = false; };
	}, [mock, savedRevision]);
	useEffect(() => { if (dirty) setPreview(null); }, [dirty]);
	const run = async (action: 'status' | 'preview' | 'activate' | 'disable'): Promise<void> => {
		setBusy(true);setError('');
		try {
			if (action === 'preview') {
				const candidate = await requestPilot<AccessV3PilotPreview>('preview');
				if (candidate.draftRevision !== savedRevision) throw new Error('Черновик изменён в другом окне. Обновите редактор.');
				setPreview(candidate);
			} else {
				if (action === 'activate' && (!preview || dirty)) throw new Error('Сначала проверьте включение сохранённой версии.');
				setStatus(await requestPilot<AccessV3PilotStatus>(action, action === 'activate' ? { previewToken: preview!.token, draftRevision: preview!.draftRevision, pilotRevision: preview!.pilotRevision } : {}));setPreview(null);
			}
		} catch (reason) { setError(reason instanceof Error ? reason.message : String(reason));setPreview(null); }
		finally { setBusy(false); }
	};
	return <section className="av3-preview" aria-label="Применение пилота прав">
		<h2>Действующая версия пилота</h2>
		<p>Только владелец #1858 · «Каталог → Видеть закупочные цены». Применяется в каталоге, окне остатков и выгрузке подборки маркетплейса. Другие сотрудники и действия не включаются.</p>
		{mock ? <p>В демо включение рабочих прав недоступно.</p> : <>
			{error && <p role="alert" className="av3-error">{error}</p>}
			<p role="status">{status ? status.state.active ? `Включена версия ${status.state.revision} из черновика ${status.state.draftRevision}: закупка ${status.state.decision === 'deny' ? 'скрыта' : 'видна при разрешении прежних проверок'}.` : 'Пилот выключен. Действуют прежние права.' : 'Статус пилота не загружен.'}</p>
			<button type="button" disabled={busy} onClick={() => void run('status')}>Обновить статус пилота</button>
			{status?.canActivate && <>
				<button type="button" disabled={busy || dirty || savedRevision < 1} onClick={() => void run('preview')}>Проверить включение сохранённой версии</button>
				<button type="button" disabled={busy || savedRevision < 1} onClick={() => void run('disable')}>Отключить пилот и вернуть прежние права</button>
				{dirty && <p>Есть несохранённые изменения. Сначала сохраните черновик; отключение действующего пилота доступно и без сохранения.</p>}
				{preview && <div className="av3-scope-note"><p>Будет включён только просмотр закупки для владельца: <b>{preview.decision === 'deny' ? 'скрыть' : 'разрешить в пределах прежнего доступа'}</b>. Черновик {preview.draftRevision}. Источник: {preview.source}. Все остальные настройки останутся черновиком.</p><button type="button" disabled={busy || dirty} onClick={() => void run('activate')}>Подтверждаю: включить только этот пилот</button></div>}
			</>}
			{status && !status.canActivate && <p>Управлять пилотом может только владелец #1858.</p>}
			{status && <details><summary>История включений и отключений ({status.history.length})</summary>{[...status.history, status.state].filter(s => s.revision > 0).reverse().map(s => <p key={s.revision}>Версия {s.revision}: {s.active ? `включена (${s.decision === 'deny' ? 'скрыть' : 'разрешить'})` : 'отключена'} · пользователь #{s.updatedById} · {s.updatedAt ? new Date(s.updatedAt).toLocaleString('ru-RU') : ''}</p>)}</details>}
		</>}
	</section>;
}
