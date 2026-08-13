import { useState } from 'react';
import { checkAdminControl, type AdminControlFinding, type AdminControlReport } from './admin-control-api.js';

export function AdminControlOverview({ onOpenFinding }: { onOpenFinding: (finding: AdminControlFinding) => void }): JSX.Element {
	const [report, setReport] = useState<AdminControlReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');

	async function check(): Promise<void> {
		setLoading(true);
		setError('');
		try {
			setReport(await checkAdminControl());
		} catch (checkError) {
			setError(checkError instanceof Error ? checkError.message : String(checkError));
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="admin-control-overview">
			<section className="admin-panel admin-control-intro">
				<div><h2>Контроль проблем</h2><p>Проверяются 10 последних цепочек сделок и 10 последних ремонтов. Проверка только читает данные.</p></div>
				<button type="button" className="btn-primary" disabled={loading} onClick={() => void check()}>{loading ? 'Проверяю…' : report ? 'Проверить ещё раз' : 'Проверить'}</button>
			</section>

			{error && <p className="admin-state error">⛔ {error}</p>}
			{loading && <p className="admin-state">Сверяю Битрикс24 и ядро склада…</p>}
			{report && !loading && <>
				<section className="admin-control-summary">
					<div><span>Сделок проверено</span><strong>{report.checkedDeals}</strong></div>
					<div><span>Ремонтов проверено</span><strong>{report.checkedRepairs}</strong></div>
					<div className={report.findings.length ? 'has-findings' : 'clean'}><span>Найдено проблем</span><strong>{report.findings.length}</strong></div>
				</section>
				{report.findings.length === 0
					? <section className="admin-panel admin-control-clean"><strong>Явных расхождений не найдено.</strong><p>Проверка завершена {new Date(report.generatedAt).toLocaleString('ru-RU')}.</p></section>
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
