import { useState } from 'react';
import type { Repair } from './b24.js';
import { repairDate as ruDate, repairDisplayNumber as repairNo } from './repair-display.js';
import { REPAIR_LOGO } from './repair-logo.js';
import { REPAIR_ACT_REQUISITE as ACT_REQUISITE, REPAIR_COPY_LABELS as COPY_LABELS } from './repair-print-settings.js';

/** Печатный «Акт сдачи оборудования в ремонт» (1–3 экземпляра). @media print прячет всё кроме акта. */
export function RepairIntakeBlank({ repair, onBack }: { repair: Repair; onBack: () => void }): JSX.Element {
	const [copies, setCopies] = useState(2);
	const equip = `${[repair.device, repair.model].filter(Boolean).join(' ')}${repair.serial ? ` / SN ${repair.serial}` : ''}` || '—';
	const copy = (label: string): JSX.Element => (
		<div className="blank-copy">
			<div className="blank-head">
				<img className="blank-logo" src={REPAIR_LOGO} alt="Умный дом" />
				<span className="blank-copylabel">Ремонт № {repairNo(repair)}{label ? ` · ${label}` : ''}</span>
			</div>
			<div className="blank-title">Акт сдачи оборудования в ремонт</div>
			<div className="blank-listlabel">Список оборудования:</div>
			<table className="blank-table">
				<thead><tr><th>Наименование (Серийный номер)</th><th className="blank-qty">Количество</th></tr></thead>
				<tbody>
					<tr><td>{equip}</td><td className="blank-qty">1</td></tr>
					<tr><td>&nbsp;</td><td className="blank-qty">&nbsp;</td></tr>
				</tbody>
			</table>
			<div className="blank-lines">
				<div>► Торговая точка: {repair.point || '—'}</div>
				<div>► Клиент: {[repair.client.name, repair.client.phone].filter(Boolean).join('  ') || '—'}</div>
				<div>► Менеджер: {repair.createdByName || '—'}</div>
				<div>Неисправность: со слов клиента: {repair.defect || '—'}</div>
				<div>Внешний вид и комплектация: {repair.appearance || '—'}</div>
				<div>Дата сдачи оборудования: {ruDate(repair.createdAt)}</div>
			</div>
			<div className="blank-signs">
				<div className="blank-sign"><div>Подпись покупателя:</div><div className="blank-signline">___________ /____________________________/</div></div>
				<div className="blank-sign"><div>Подпись продавца:</div><div className="blank-signline">___________ /____________________________/</div></div>
			</div>
			<div className="blank-req">{ACT_REQUISITE}</div>
			<div className="blank-mp">М. П.</div>
		</div>
	);
	const labels = Array.from({ length: copies }, (_, i) => COPY_LABELS[i] ?? `экземпляр ${i + 1}`);
	return (
		<div className="repair-blank-wrap">
			<div className="blank-toolbar no-print">
				<button className="btn-secondary" onClick={onBack}>← Назад</button>
				<span className="muted small">Экземпляров:</span>
				{[1, 2, 3].map((n) => (
					<button key={n} className={`btn-secondary${copies === n ? ' active' : ''}`} onClick={() => setCopies(n)}>{n}</button>
				))}
				<button className="btn-primary" onClick={() => window.print()}>🖨 Печать</button>
			</div>
			<div className="repair-blank">
				{labels.map((lb, i) => (
					<div key={i} className="blank-page">{copy(lb)}</div>
				))}
			</div>
		</div>
	);
}
