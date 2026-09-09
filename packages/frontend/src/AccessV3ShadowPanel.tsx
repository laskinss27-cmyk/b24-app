import { useEffect, useState } from 'react';
import { ACCESS_PERMISSIONS, type AccessV3ShadowReport } from '@b24-app/shared';
import { accessV3Request } from './access-v3-api.js';

export function groupShadowObservations(observations: AccessV3ShadowReport['observations']) {
	const groups = new Map<string, AccessV3ShadowReport['observations'][number] & { count: number; firstAt: string }>();
	for (const row of observations) {
		const key = JSON.stringify([row.userId, row.permissionId, row.route, row.revision, row.actual, row.proposed, row.source, row.conflict, row.httpStatus]);
		const existing = groups.get(key);
		if (existing) {
			existing.count++;
			if (Date.parse(row.at) < Date.parse(existing.firstAt)) existing.firstAt = row.at;
			if (Date.parse(row.at) > Date.parse(existing.at)) existing.at = row.at;
		} else groups.set(key, { ...row, count: 1, firstAt: row.at });
	}
	return [...groups.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function AccessV3ShadowPanel({ initial, mock }: { initial: AccessV3ShadowReport | undefined; mock: boolean }): JSX.Element {
	const [report, setReport] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	useEffect(() => setReport(initial), [initial]);
	const refresh = async (): Promise<void> => {
		setBusy(true);setError('');
		try { setReport(await accessV3Request('shadow')); }
		catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
		finally { setBusy(false); }
	};
	return <details className="av3-preview"><summary>Диагностика · техническое сравнение прав</summary><section aria-label="Серверная проверка прав">
		<h2>Проверка без изменения доступа</h2>
		<p>Пилот: только аккаунт владельца #1858 и просмотр закупочных цен в каталоге, окне остатков и выгрузке подборки маркетплейса.</p>
		<p>Этот блок сравнивает черновик с прежней проверкой и сам не применяет права. Это не история изменений и не список ошибок. Отдельно включённая версия может ограничивать просмотр закупки — смотрите её статус выше. Сделки, проведение документов и доступ по складам в пилот не входят.</p>
		{mock ? <p>Это демо редактора: реальных серверных наблюдений здесь нет.</p> : <>
			<button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Обновляю…' : 'Обновить результаты проверки'}</button>
			{error && <p role="alert" className="av3-error">{error}</p>}
			{report ? <>
				<p>Проверок: {report.total} · расхождений: {report.differences} · пропусков: {report.skipped}</p>
				{report.lastSkip && <p>Последний пропуск: {report.lastSkip}. Это не подтверждение совпадения прав.</p>}
				{!report.total && <p>Наблюдений пока нет. После запуска пилота откройте каталог под своим аккаунтом и обновите этот блок.</p>}
				<small>С {new Date(report.startedAt).toLocaleString('ru-RU')}. Последние 200 наблюдений текущего процесса; перезапуск сервера очищает статистику. HTTP-код не подтверждает успешность всей операции.</small>
				<p>Повторы объединены в пределах последних {report.observations.length} сохранённых наблюдений. Счётчики выше — за всё время работы процесса, не только за открытие этого окна.</p>
				<div className="av3-preview-list">{groupShadowObservations(report.observations).map((row, index) => <div key={`${row.at}:${index}`}>
					<b>{row.actual === row.proposed ? 'Совпадает' : 'Расхождение'}</b>
					<span>По прежним правилам: {row.actual ? 'видно' : 'скрыто'} → по черновику: {row.proposed ? 'видно' : 'скрыто'}</span>
					<span>Черновик {row.revision} · HTTP {row.httpStatus} · Проверок: {row.count}</span>
					<small>Сотрудник #{row.userId} · {ACCESS_PERMISSIONS.find(p => p.id === row.permissionId)?.label ?? row.permissionId} · {row.route} · {row.source}{row.conflict ? ' · конфликт отделов' : ''} · С {new Date(row.firstAt).toLocaleString('ru-RU')} по {new Date(row.at).toLocaleString('ru-RU')}</small>
				</div>)}</div>
			</> : <p>Результаты ещё не загружены.</p>}
		</>}
	</section></details>;
}
