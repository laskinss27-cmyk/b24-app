import { openDeal, openTask } from './b24.js';
import type { AdminRepairDiagnostic, DiagnosticStockDocument } from './admin-repair-diagnostics-api.js';

const STATUS_LABELS: Record<string, string> = {
	received_tt: 'Принято на точке', received_office: 'Принято в офисе', sent: 'Отправлено в ремонт',
	sent_to_tt: 'Возвращается на точку', ready_tt: 'Готово к выдаче', issued: 'Выдано',
	pre_office: 'На складе офиса', pre_sent: 'Отправлено в ремонт', pre_back_office: 'Вернулось в офис',
	pre_to_point: 'Отправлено на точку', pre_at_tt: 'Принято на точке',
};

function value(value: unknown): string {
	return value === null || value === undefined || value === '' ? '—' : String(value);
}

function documentStatus(status: number): string {
	return status === 1 ? 'проведён' : status === 2 ? 'отменён' : 'черновик';
}

function movement(document: DiagnosticStockDocument): string {
	if (document.type === 'Purchase Receipt') return `→ ${value(document.toStore)}`;
	if (document.type === 'Delivery Note') return `${value(document.fromStore)} → клиенту`;
	return `${value(document.fromStore)} → ${value(document.toStore)}`;
}

export function RepairDiagnosticDetails({ diagnostic }: { diagnostic: AdminRepairDiagnostic }): JSX.Element {
	const { repair, erp, deal, task } = diagnostic;
	return (
		<div className="repair-diagnostic-details">
			<section className="admin-diagnostic-summary">
				<div><span>Ремонт</span><strong>#{repair.repairNo || repair.id}</strong></div>
				<div><span>Статус</span><strong>{STATUS_LABELS[repair.status] ?? repair.status}</strong></div>
				<div><span>Клиент</span><strong>{value(repair.client.name)}</strong></div>
				<div><span>Аппарат</span><strong>{[repair.device, repair.model].filter(Boolean).join(' · ') || '—'}</strong></div>
				<div><span>Серийный номер</span><strong>{value(repair.serial)}</strong></div>
				<div><span>Отказ клиента</span><strong>{repair.clientRefusal ? repair.clientRefusal.reason : 'нет'}</strong></div>
			</section>

			<section className="admin-panel">
				<h3>Проверка состояния</h3>
				{diagnostic.issues.length === 0
					? <p className="admin-clean-state">Явных расхождений не найдено.</p>
					: <div className="admin-issues">{diagnostic.issues.map((issue) => (
						<article key={issue.code} className={`admin-issue ${issue.severity}`}>
							<strong>{issue.title}</strong><p>{issue.details}</p>
						</article>
					))}</div>}
			</section>

			<div className="admin-diagnostic-grid">
				<section className="admin-panel">
					<h3>Склад</h3>
					{!erp.preciseStockSupported && <p>Для предпродажного ремонта нельзя однозначно выделить конкретную единицу из общего остатка товара.</p>}
					<dl>
						<dt>Код позиции</dt><dd>{value(erp.itemCode)}</dd>
						<dt>Склад по статусу</dt><dd>{value(diagnostic.expectedStore)}</dd>
						<dt>Склад в карточке</dt><dd>{value(repair.repairStore)}</dd>
						<dt>Фактически в ядре</dt><dd>{erp.stockError ? `Ошибка: ${erp.stockError}` : `${value(erp.stockLocation)}${erp.stockQty !== null ? ` · ${erp.stockQty} шт.` : ''}`}</dd>
					</dl>
				</section>

				<section className="admin-panel">
					<h3>Сделка</h3>
					{deal ? <>
						<dl><dt>ID</dt><dd>#{deal.id}</dd><dt>Название</dt><dd>{value(deal.title)}</dd><dt>Этап</dt><dd>{value(deal.stageId)}</dd><dt>Закрыта</dt><dd>{deal.closed === null ? '—' : deal.closed ? 'да' : 'нет'}</dd><dt>Семантика</dt><dd>{value(deal.semantic)}</dd></dl>
						<button type="button" className="btn-secondary" onClick={() => openDeal(deal.id)}>Открыть сделку</button>
					</> : <p>Сделка к ремонту не привязана.</p>}
				</section>

				<section className="admin-panel">
					<h3>Задача</h3>
					{task ? <>
						<dl><dt>ID</dt><dd>#{task.id}</dd><dt>Название</dt><dd>{value(task.title)}</dd><dt>Статус</dt><dd>{value(task.status)}</dd><dt>Завершена</dt><dd>{task.completed === null ? '—' : task.completed ? 'да' : 'нет'}</dd><dt>Ответственный</dt><dd>{value(task.responsible)}</dd></dl>
						<button type="button" className="btn-secondary" onClick={() => openTask(task.id)}>Открыть задачу</button>
					</> : <p>Задача к ремонту не привязана.</p>}
				</section>
			</div>

			<section className="admin-panel">
				<h3>Складские документы</h3>
				{erp.documents.length === 0 ? <p>Документы по ремонтной позиции не найдены.</p> : (
					<div className="admin-documents">{erp.documents.map((document) => (
						<div key={`${document.type}-${document.name}`}>
							<strong>{document.type} · {document.name}</strong>
							<span>{movement(document)}</span>
							<span>{documentStatus(document.docstatus)} · {value(document.postingDate || document.creation)}</span>
						</div>
					))}</div>
				)}
			</section>

			<details className="admin-raw-json"><summary>Исходная структура карточки (JSON)</summary><pre>{JSON.stringify(diagnostic.rawRecord, null, 2)}</pre></details>
		</div>
	);
}
