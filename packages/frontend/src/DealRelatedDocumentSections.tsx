import type { AdminDealApplicationDocuments } from './admin-deal-documents-api.js';

function rub(amount: number): string {
	return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount) + ' ₽';
}

export function DealRelatedDocumentSections({ documents }: { documents: AdminDealApplicationDocuments }): JSX.Element {
	return (
		<>
			{documents.contracts.length > 0 && <section className="admin-panel"><h3>Договоры</h3><div className="admin-related-cards">
				{documents.contracts.map((document) => <article key={document.id}>
					<strong>{document.templateTitle} № {document.contractNumber}</strong>
					<span>{document.contractDate || document.createdAt || 'дата не указана'}</span>
					<span>{document.companyName} → {document.customerName}</span>
					<span>{rub(document.total)} · {document.filename}</span>
				</article>)}
			</div></section>}

			{documents.supplyCards.length > 0 && <section className="admin-panel"><h3>Карточки снабжения Битрикс24</h3><div className="admin-related-cards">
				{documents.supplyCards.map((document) => <article key={document.id}>
					<strong>#{document.id} · {document.title || 'Без названия'}</strong>
					<span>Стадия: {document.stageId || '—'}</span>
				</article>)}
			</div></section>}

			{documents.transfers.length > 0 && <section className="admin-panel"><h3>Документы перемещения приложения</h3><div className="admin-related-cards">
				{documents.transfers.map((document) => <article key={document.id}>
					<strong>{document.name || `Перемещение #${document.id}`}</strong>
					<span>{document.fromStore || '—'} → {document.toStore || '—'} · {document.status}</span>
					<span>Создал: {document.createdByName || '—'} · событий: {document.historyCount}</span>
					{document.supplyRequest && <span>Заявка: {document.supplyRequest}</span>}
					{document.purchaseOrder && <span>Закупка: {document.purchaseOrder}</span>}
					{document.shipEntry && <span>Отправка ядра: {document.shipEntry}</span>}
					{document.receiveEntry && <span>Приёмка ядра: {document.receiveEntry}</span>}
					{document.note && <span>{document.note}</span>}
					{document.items.length > 0 && <small>{document.items.map((item) => `${item.itemName || `#${item.productId}`} × ${item.qty}`).join(' · ')}</small>}
				</article>)}
			</div></section>}
		</>
	);
}
