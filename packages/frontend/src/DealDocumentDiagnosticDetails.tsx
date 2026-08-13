import { openDeal } from './b24.js';
import type { AdminDealDocument, AdminDealDocumentDiagnostic } from './admin-deal-documents-api.js';
import { DealRelatedDocumentSections } from './DealRelatedDocumentSections.js';

function value(input: unknown): string {
	return input === null || input === undefined || input === '' ? '—' : String(input);
}

function status(document: AdminDealDocument): string {
	return document.docstatus === 1 ? 'проведён' : document.docstatus === 2 ? 'отменён' : 'черновик';
}

function rub(amount: number): string {
	return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount) + ' ₽';
}

function DocumentCard({ document }: { document: AdminDealDocument }): JSX.Element {
	return (
		<article className="admin-deal-document">
			<header>
				<div><strong>{document.label} · {document.name}</strong><small>{document.postingDate || document.creation || 'дата не указана'}</small></div>
				<span className={`admin-document-status status-${document.docstatus}`}>{status(document)}</span>
			</header>
			<div className="admin-document-meta">
				<span>Сумма: <b>{rub(document.total)}</b></span>
				{document.supplier && <span>Поставщик: <b>{document.supplier}</b></span>}
				{document.supplyRequest && <span>Заявка: <b>{document.supplyRequest}</b></span>}
				{document.purchaseOrder && <span>Заказ поставщику: <b>{document.purchaseOrder}</b></span>}
				{document.stockEntryType && <span>Тип движения: <b>{document.stockEntryType}</b></span>}
				{document.returnAgainst && <span>Возврат к: <b>{document.returnAgainst}</b></span>}
				{document.amendedFrom && <span>Исправляет: <b>{document.amendedFrom}</b></span>}
			</div>
			{document.note && <p className="admin-document-note">{document.note}</p>}
			{document.items.length === 0 ? <p>В документе нет строк.</p> : (
				<div className="admin-document-items-wrap"><table className="admin-document-items">
					<thead><tr><th>Позиция</th><th>Код</th><th>Склад</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead>
					<tbody>{document.items.map((item) => <tr key={item.rowName || `${item.itemCode}-${item.qty}`}>
						<td>{item.itemName || '—'}</td><td>{item.itemCode || '—'}</td><td>{item.warehouse || item.targetWarehouse || '—'}</td>
						<td>{item.qty}</td><td>{rub(item.rate)}</td><td>{rub(item.amount)}</td>
					</tr>)}</tbody>
				</table></div>
			)}
		</article>
	);
}

export function DealDocumentDiagnosticDetails({ diagnostic }: { diagnostic: AdminDealDocumentDiagnostic }): JSX.Element {
	const { deal } = diagnostic;
	const applicationCount = diagnostic.applicationDocuments.contracts.length + diagnostic.applicationDocuments.supplyCards.length + diagnostic.applicationDocuments.transfers.length;
	return (
		<div className="deal-document-diagnostic-details">
			<section className="admin-diagnostic-summary">
				<div><span>Сделка</span><strong>#{deal.id}</strong></div>
				<div><span>Название</span><strong>{value(deal.title)}</strong></div>
				<div><span>Этап</span><strong>{value(deal.stageId)}</strong></div>
				<div><span>Закрыта</span><strong>{deal.closed === null ? '—' : deal.closed ? 'да' : 'нет'}</strong></div>
				<div><span>Полная отгрузка в Битрикс24</span><strong>{value(deal.fulfillmentField)}</strong></div>
				<div><span>Расчёт по ядру</span><strong>{diagnostic.calculatedFulfillment}</strong></div>
			</section>

			<section className="admin-panel admin-deal-actions">
				<button type="button" className="btn-secondary" onClick={() => openDeal(deal.id)}>Открыть сделку</button>
				<span>Документов в цепочке: {diagnostic.documents.length + applicationCount}</span>
			</section>

			<section className="admin-panel">
				<h3>Проверка состояния</h3>
				{diagnostic.issues.length === 0
					? <p className="admin-clean-state">Явных расхождений не найдено.</p>
					: <div className="admin-issues">{diagnostic.issues.map((issue) => <article key={issue.code} className={`admin-issue ${issue.severity}`}><strong>{issue.title}</strong><p>{issue.details}</p></article>)}</div>}
			</section>

			<section className="admin-deal-documents">
				{diagnostic.documents.length === 0 ? <div className="admin-panel"><p>Связанных документов ядра не найдено.</p></div> : diagnostic.documents.map((document) => <DocumentCard key={`${document.type}-${document.name}`} document={document} />)}
			</section>

			<DealRelatedDocumentSections documents={diagnostic.applicationDocuments} />

			<details className="admin-raw-json"><summary>Диагностическая структура (JSON)</summary><pre>{JSON.stringify(diagnostic, null, 2)}</pre></details>
		</div>
	);
}
