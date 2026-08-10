import type { Repair } from './b24.js';
import { repairCompleteness, repairDate, repairDisplayNumber } from './repair-display.js';
import { REPAIR_LOGO } from './repair-logo.js';

export interface RepairDispatchContact {
	name: string;
	phone: string;
}

/** Сводное сопроводительное письмо для передачи выбранного оборудования в сервис. */
export function RepairDispatchBlank({ repairs, contact, onBack }: {
	repairs: Repair[];
	contact: RepairDispatchContact;
	onBack: () => void;
}): JSX.Element {
	return (
		<div className="repair-blank-wrap repair-dispatch-wrap">
			<div className="blank-toolbar no-print">
				<button className="btn-secondary" onClick={onBack}>← Назад</button>
				<span className="muted small">Выбрано ремонтов: {repairs.length}</span>
				<button className="btn-primary" onClick={() => window.print()}>Печать</button>
			</div>
			<div className="repair-blank repair-dispatch-letter">
				<div className="blank-head">
					<img className="blank-logo" src={REPAIR_LOGO} alt="Умный дом" />
					<div className="repair-dispatch-meta">
						<span>Дата: {repairDate(new Date().toISOString())}</span>
						{contact.name && <span>Контактное лицо: {contact.name}</span>}
						{contact.phone && <span>Телефон: {contact.phone}</span>}
					</div>
				</div>
				<div className="blank-title">Сопроводительное письмо</div>
				<table className="blank-table repair-dispatch-table">
					<thead><tr><th>Номер ремонта</th><th>Модель</th><th>Серийный номер</th><th>Неисправность</th><th>Комплектация</th></tr></thead>
					<tbody>
						{repairs.map((repair) => (
							<tr key={repair.id}>
								<td>#{repairDisplayNumber(repair)}</td>
								<td>{repair.model || repair.device || '—'}</td>
								<td>{repair.serial || '—'}</td>
								<td>{repair.defect || '—'}</td>
								<td>{repairCompleteness(repair)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
