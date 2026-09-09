import { useEffect, useState } from 'react';
import type { AccessV3ShadowReport } from '@b24-app/shared';
import { accessV3Request } from './access-v3-api.js';

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
	return <section className="av3-preview" aria-label="Серверная проверка прав">
		<h2>Проверка без изменения доступа</h2>
		<p>Пилот: только аккаунт владельца #1858 и просмотр закупочных цен в каталоге, окне остатков и выгрузке подборки маркетплейса.</p>
		<p>Этот блок сравнивает черновик с прежней проверкой и сам не применяет права. Отдельно включённая версия может ограничивать просмотр закупки — смотрите её статус ниже. Сделки, проведение документов и доступ по складам в пилот не входят.</p>
		{mock ? <p>Это демо редактора: реальных серверных наблюдений здесь нет.</p> : <>
			<button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Обновляю…' : 'Обновить результаты проверки'}</button>
			{error && <p role="alert" className="av3-error">{error}</p>}
			{report ? <>
				<p>Проверок: {report.total} · расхождений: {report.differences} · пропусков: {report.skipped}</p>
				{report.lastSkip && <p>Последний пропуск: {report.lastSkip}. Это не подтверждение совпадения прав.</p>}
				{!report.total && <p>Наблюдений пока нет. После запуска пилота откройте каталог под своим аккаунтом и обновите этот блок.</p>}
				<small>С {new Date(report.startedAt).toLocaleString('ru-RU')}. Последние 200 наблюдений текущего процесса; перезапуск сервера очищает статистику. HTTP-код не подтверждает успешность всей операции.</small>
				<div className="av3-preview-list">{report.observations.slice().reverse().map((row, index) => <div key={`${row.at}:${index}`}>
					<b>{row.actual === row.proposed ? 'Совпадает' : 'Расхождение'}</b>
					<span>По прежним правилам: {row.actual ? 'видно' : 'скрыто'} → по черновику: {row.proposed ? 'видно' : 'скрыто'}</span>
					<span>Версия {row.revision} · HTTP {row.httpStatus}</span>
					<small>{row.route} · {row.source}{row.conflict ? ' · конфликт отделов' : ''} · {new Date(row.at).toLocaleString('ru-RU')}</small>
				</div>)}</div>
			</> : <p>Результаты ещё не загружены.</p>}
		</>}
	</section>;
}
