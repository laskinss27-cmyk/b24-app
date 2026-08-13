import { useState } from 'react';
import { checkAdminControl, type AdminControlFinding, type AdminControlProgress, type AdminControlReport } from './admin-control-api.js';

function inputDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function defaultPeriod(): { dateFrom: string; dateTo: string } {
	const dateTo = new Date();
	const dateFrom = new Date(dateTo);
	dateFrom.setDate(dateFrom.getDate() - 30);
	return { dateFrom: inputDate(dateFrom), dateTo: inputDate(dateTo) };
}

export function AdminControlOverview({ onOpenFinding }: { onOpenFinding: (finding: AdminControlFinding) => void }): JSX.Element {
	const initialPeriod = defaultPeriod();
	const [dateFrom, setDateFrom] = useState(initialPeriod.dateFrom);
	const [dateTo, setDateTo] = useState(initialPeriod.dateTo);
	const [report, setReport] = useState<AdminControlReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [progress, setProgress] = useState<AdminControlProgress | null>(null);
	const [error, setError] = useState('');

	async function check(): Promise<void> {
		setLoading(true);
		setError('');
		setProgress(null);
		setReport(null);
		try {
			setReport(await checkAdminControl(dateFrom, dateTo, setProgress));
		} catch (checkError) {
			setError(checkError instanceof Error ? checkError.message : String(checkError));
		} finally {
			setLoading(false);
			setProgress(null);
		}
	}

	return (
		<div className="admin-control-overview">
			<section className="admin-panel admin-control-intro">
				<div><h2>Контроль проблем</h2><p>Проверяются все цепочки сделок и ремонты с активностью в выбранном периоде. Проверка только читает данные.</p></div>
				<div className="admin-control-period">
					<label>С<input type="date" value={dateFrom} max={dateTo} onChange={(event) => { setDateFrom(event.target.value); setReport(null); }} /></label>
					<label>По<input type="date" value={dateTo} min={dateFrom} onChange={(event) => { setDateTo(event.target.value); setReport(null); }} /></label>
					<button type="button" className="btn-primary" disabled={loading || !dateFrom || !dateTo || dateFrom > dateTo} onClick={() => void check()}>{loading ? 'Проверяю…' : report ? 'Проверить ещё раз' : 'Проверить'}</button>
				</div>
			</section>

			{error && <p className="admin-state error">⛔ {error}</p>}
			{loading && <p className="admin-state">{progress
				? `Проверено ${progress.checkedDeals + progress.checkedRepairs} из ${progress.totalDeals + progress.totalRepairs}: сделки ${progress.checkedDeals}/${progress.totalDeals}, ремонты ${progress.checkedRepairs}/${progress.totalRepairs}.`
				: 'Собираю список сделок и ремонтов…'}</p>}
			{report && !loading && <>
				<section className="admin-control-summary">
					<div><span>Сделок проверено</span><strong>{report.checkedDeals}</strong></div>
					<div><span>Ремонтов проверено</span><strong>{report.checkedRepairs}</strong></div>
					<div className={report.findings.length ? 'has-findings' : 'clean'}><span>Найдено проблем</span><strong>{report.findings.length}</strong></div>
				</section>
				<p className="admin-control-range">Проверенный период: {report.dateFrom} — {report.dateTo}</p>
				{report.findings.length === 0
					? <section className="admin-panel admin-control-clean"><strong>Явных расхождений не найдено.</strong><p>Период: {report.dateFrom} — {report.dateTo}. Проверка завершена {new Date(report.generatedAt).toLocaleString('ru-RU')}.</p></section>
					: <section className="admin-control-findings">{report.findings.map((finding) => (
						<article key={finding.id} className={`admin-control-finding ${finding.severity}`}>
							<div><span>{finding.entityLabel}</span><strong>{finding.title}</strong><p>{finding.details}</p></div>
							<button type="button" className="btn-secondary" onClick={() => onOpenFinding(finding)}>Открыть диагностику</button>
						</article>
					))}</section>}
			</>}
			{!report && !loading && !error && <p className="admin-state">Проверка ещё не запускалась.</p>}
		</div>
	);
}
