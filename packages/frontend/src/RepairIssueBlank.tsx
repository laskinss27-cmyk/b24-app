import type { Repair, RepairStatus } from './b24.js';
import { repairDate as ruDate, repairDisplayNumber as repairNo, repairMoney as money } from './repair-display.js';
import { REPAIR_LOGO } from './repair-logo.js';
import { REPAIR_ACT_REQUISITE as ACT_REQUISITE } from './repair-print-settings.js';

function repairHistoryDate(repair: Repair, status: RepairStatus): string {
	const entry = repair.history.find((row) => row.status === status && !row.note);
	return entry?.at ? ruDate(entry.at) : '';
}

/** Акт передачи клиенту: два экземпляра, только известные системе факты без сведений о деталях СЦ. */
export function RepairIssueBlank({ repair, onBack }: { repair: Repair; onBack: () => void }): JSX.Element {
	const acceptedAt = ruDate(repair.createdAt);
	const completedAt = repairHistoryDate(repair, 'ready_tt');
	const issuedAt = repairHistoryDate(repair, 'issued') || ruDate(new Date().toISOString());
	const equipment = [repair.device, repair.model].filter(Boolean).join(' ') || '—';
	const issuePoint = repair.issueStore || repair.point || '—';
	const repairPrice = repair.payType === 'paid' && repair.ourPrice != null ? money(repair.ourPrice) : '0 ₽';
	const workText = repair.comment.trim() || '—';
	const copy = (label: string): JSX.Element => (
		<div className="blank-copy repair-issue-copy">
			<div className="blank-head repair-issue-head">
				<div>
					<img className="blank-logo" src={REPAIR_LOGO} alt="Умный дом" />
					<div className="repair-issue-org">{ACT_REQUISITE}</div>
					<div className="repair-issue-muted">Торговая точка выдачи: {issuePoint}</div>
				</div>
				<span className="blank-copylabel">Ремонт № {repairNo(repair)} · {label}</span>
			</div>

			<div className="blank-title repair-issue-title">Акт выдачи оборудования после ремонта № {repairNo(repair)}</div>
			<div className="repair-issue-subtitle">Составлен {issuedAt} в двух экземплярах</div>

			<div className="repair-issue-parties">
				<div><span>Исполнитель</span><b>{ACT_REQUISITE}</b></div>
				<div><span>Клиент</span><b>{repair.client.name || '—'}</b><small>{repair.client.phone}</small></div>
			</div>

			<table className="blank-table repair-issue-table">
				<tbody>
					<tr><th>Оборудование</th><td>{equipment}</td><th>Серийный номер</th><td>{repair.serial || '—'}</td></tr>
					<tr><th>Принято от клиента</th><td>{acceptedAt || '—'}</td><th>Выдано клиенту</th><td>{issuedAt}</td></tr>
					<tr><th>Ремонт завершён</th><td colSpan={3}>{completedAt || '—'}</td></tr>
				</tbody>
			</table>

			<div className="repair-issue-section">
				<span>Заявленная неисправность</span>
				<p>{repair.defect || '—'}</p>
			</div>
			<div className="repair-issue-section">
				<span>Состояние и комплектность при приёме</span>
				<p>{repair.appearance || '—'}</p>
			</div>
			<div className="repair-issue-section">
				<span>Выполненные работы</span>
				<p>{workText}</p>
			</div>

			<div className="repair-issue-terms">
				<div><span>Вид ремонта</span><b>{repair.payType === 'warranty' ? '☑ Гарантийный   ☐ Платный' : '☐ Гарантийный   ☑ Платный'}</b></div>
				<div><span>Стоимость ремонта</span><b>{repairPrice}</b></div>
			</div>

			<div className="repair-issue-section repair-issue-handover">
				<span>Передача клиенту</span>
				<p><b>Комплектность и внешний вид:</b> соответствуют состоянию, зафиксированному при приёме, кроме замечаний ниже.</p>
				<p><b>Проверка:</b> ☐ проведена в присутствии клиента &nbsp;&nbsp; ☐ клиент отказался от проверки.</p>
				<p><b>Замечания клиента при выдаче:</b> __________________________________________________________</p>
			</div>

			<div className="repair-issue-receipt">
				Оборудование и один экземпляр настоящего акта получил. Комплектность и внешний вид при выдаче проверены,
				результат выполненных работ продемонстрирован в объёме, доступном в месте выдачи. Подпись подтверждает
				факт передачи оборудования и зафиксированные выше обстоятельства, но не ограничивает права клиента
				в отношении скрытых недостатков и иные права, предусмотренные законом.
			</div>

			<div className="repair-issue-signatures">
				<div><span>Выдал, представитель исполнителя</span><p>____________ / ________________________</p></div>
				<div><span>Получил, клиент</span><p>____________ / {repair.client.name || '________________________'}</p></div>
			</div>

			<div className="repair-issue-footer">
				При повторном обращении по той же неисправности рекомендуется предъявить этот акт.
			</div>
		</div>
	);

	return (
		<div className="repair-blank-wrap repair-issue-wrap">
			<div className="blank-toolbar no-print">
				<button className="btn-secondary" onClick={onBack}>← Назад</button>
				<span className="muted small">Два экземпляра: клиенту и торговой точке</span>
				<button className="btn-primary" onClick={() => window.print()}>Печать</button>
			</div>
			<div className="repair-blank repair-issue-blank">
				<div className="blank-page">{copy('экземпляр клиента')}</div>
				<div className="blank-page">{copy('экземпляр точки')}</div>
			</div>
		</div>
	);
}

