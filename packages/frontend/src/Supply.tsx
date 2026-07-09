import { useCallback, useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import { fetchCurrentUserId, isPortalAdmin, withTimeout, BETA_USER_IDS, fetchSupplyOrders, fetchSupplySuppliers, createTransfers, createSupplyPurchaseOrder, receiveSupplyPurchase, updateSupplyPurchaseStage, type SupplyOrderItem, type SupplyOrderRow, type SupplyPurchaseChild, type SupplyPurchaseStage, type TransferLineDto } from './b24.js';

type SectionKey = 'orders' | 'logistics' | 'purchase' | 'payment' | 'stock' | 'reports';
const SECTIONS: Array<{ key: SectionKey; title: string; group: string }> = [
	{ key: 'orders', title: 'Заявки', group: 'Операции' },
	{ key: 'logistics', title: 'Логистика', group: 'Операции' },
	{ key: 'purchase', title: 'Закупки', group: 'Операции' },
	{ key: 'payment', title: 'Согласование оплат', group: 'Операции' },
	{ key: 'stock', title: 'Документы склада', group: 'Склад' },
	{ key: 'reports', title: 'Отчеты', group: 'Аналитика' },
];

const MOCK_ORDERS: SupplyOrderRow[] = [
	{ name: 'MAT-MR-2026-0001', dealId: '556', dealTitle: 'Монтаж видеонаблюдения', date: '2026-04-04', status: 'Pending', closed: false, toStore: 'Максидом Дунайский 64', items: [
		{ productId: 104, itemName: 'Блок питания 12В 5А', qty: 4, note: '', stocks: { 'ЦС': 0, 'Парнас': 0, 'Девяткино': 0 } },
		{ productId: 103, itemName: 'Видеорегистратор 8-канальный', qty: 1, note: 'нужен новый, в пленке', stocks: { 'Офис': 4, 'Парнас': 0 } },
		{ productId: 301, itemName: 'IP-камера 4 Мп CTV-IPB2028', qty: 6, note: '', stocks: { 'Парнас': 2, 'Офис': 1, 'Девяткино': 0, 'Богатырский': 0 } },
	], purchases: [
		{
			name: 'PO-DEMO-0001',
			supplier: 'ТД Север',
			status: 'To Receive and Bill',
			supplyStage: 'ordered',
			orderedAt: '2026-04-05',
			expectedAt: '2026-04-09',
			total: 33080,
			lines: [
				{ productId: 301, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 4, rate: 7350 },
				{ productId: 104, name: 'Блок питания 12В 5А', qty: 4, rate: 920 },
			],
			receipts: [
				{ name: 'PR-DEMO-0001', status: 'Completed', purchaseOrder: 'PO-DEMO-0001', lines: [{ productId: 301, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 2, rate: 7350, warehouse: 'Офис' }] },
			],
		},
		{
			name: 'PO-DEMO-0002',
			supplier: 'Линия Безопасности',
			status: 'Draft',
			supplyStage: 'approval',
			expectedAt: '2026-04-10',
			total: 13780,
			lines: [{ productId: 301, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 2, rate: 6890 }],
			receipts: [],
		},
	] },
	{ name: 'MAT-MR-2026-0002', dealId: '553', dealTitle: 'СКУД офис', date: '2026-04-03', status: 'Pending', closed: false, toStore: 'Измайловский 18Д', items: [
		{ productId: 202, itemName: 'Контроллер СКУД ZKTeco', qty: 4, note: '', stocks: {} },
	] },
	{ name: 'MAT-MR-2026-0003', dealId: '551', dealTitle: 'Камеры ТТ Богатырский', date: '2026-04-02', status: 'Ordered', closed: true, toStore: 'Богатырский', items: [
		{ productId: 301, itemName: 'Видеокамера CTV-IPB2028', qty: 4, note: '', stocks: { 'ЦС': 20, 'Девяткино': 6 } },
	] },
];

const STUB: Record<Exclude<SectionKey, 'orders'>, { title: string; note: string }> = {
	logistics: { title: 'Логистика', note: 'Перемещения между складами через транзит. Раздел подключим после утверждения потока заявок.' },
	purchase: { title: 'Закупки', note: 'Закупки по дефициту из заявок снабжения. Здесь будут поставщики, счета и статусы закупа.' },
	payment: { title: 'Согласование оплат', note: 'Согласование счетов через смарт-процесс Б24 после готовности процесса у интегратора.' },
	stock: { title: 'Документы склада', note: 'Ручные складские документы: перемещение, списание, оприходование, возвраты и движение товара.' },
	reports: { title: 'Отчеты', note: 'Остатки, залежалость, движение товара и контроль заявок по срокам.' },
};

type DecisionKind = 'transfer' | 'purchase';
interface Decision {
	id: string;
	productId: number;
	qty: number;
	kind: DecisionKind;
	warehouse?: string;
	supplier?: string;
	rate?: number;
}
type DecisionMap = Record<string, Decision[]>;
type DraftInput = Record<string, { qty: number; kind: DecisionKind; warehouse: string; supplier: string; rate: number }>;
type ReceiveDraft = Record<string, number>;
const DEFAULT_SUPPLIER = 'Поставщик не выбран';
const DEFAULT_RECEIPT_STORE = 'Склад Прихода';

const plural = (n: number, one: string, few: string, many: string): string => {
	const m10 = n % 10;
	const m100 = n % 100;
	if (m10 === 1 && m100 !== 11) return one;
	if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
	return many;
};

const statusLabel = (status: string, closed: boolean): string => {
	if (closed) return 'закрыта';
	if (/ordered/i.test(status)) return 'заказано';
	if (/pending/i.test(status)) return 'новая';
	return status || 'в работе';
};
const plannedQtyForOrder = (order: SupplyOrderRow, decisions: DecisionMap): number =>
	order.items.reduce((sum, item, index) => {
		const key = itemKey(order.name, item.productId, index);
		return sum + (decisions[key] ?? []).reduce((a, row) => a + row.qty, 0);
	}, 0);
const requestItemsForOrder = (order: SupplyOrderRow): SupplyOrderItem[] => order.originalItems?.length ? order.originalItems : order.items;
const requestedQtyForOrder = (order: SupplyOrderRow): number => requestItemsForOrder(order).reduce((sum, item) => sum + item.qty, 0);
const documentedQtyForOrder = (order: SupplyOrderRow): number =>
	(order.transfers ?? []).reduce((sum, transfer) => sum + transfer.lines.reduce((a, line) => a + line.qty, 0), 0)
	+ (order.purchases ?? []).reduce((sum, purchase) => sum + purchase.lines.reduce((a, line) => a + line.qty, 0), 0);
const supplyDocumentCount = (order: SupplyOrderRow): number =>
	(order.transfers?.length ?? 0)
	+ (order.purchases?.length ?? 0)
	+ (order.purchases ?? []).reduce((sum, purchase) => sum + purchase.receipts.length, 0);
const orderStatusView = (order: SupplyOrderRow, decisions: DecisionMap = {}): { label: string; className: string; note: string } => {
	const requested = requestedQtyForOrder(order);
	const planned = plannedQtyForOrder(order, decisions);
	const documented = documentedQtyForOrder(order);
	const docs = (order.transfers?.length ?? 0) + (order.purchases?.length ?? 0);
	if (order.closed) return { label: 'закрыта', className: 'done', note: 'работа завершена' };
	if (docs > 0 && planned > 0) return { label: documented + planned >= requested ? 'документы + план' : 'частично в работе', className: 'active', note: `в документах ${documented} шт, в плане ${planned} шт` };
	if (docs > 0 && documented >= requested) return { label: 'документы созданы', className: 'active', note: `${docs} ${plural(docs, 'документ', 'документа', 'документов')} · ${documented} из ${requested} шт` };
	if (docs > 0) return { label: 'часть в документах', className: 'active', note: `${docs} ${plural(docs, 'документ', 'документа', 'документов')} · ${documented} из ${requested} шт` };
	if (planned >= requested && requested > 0) return { label: 'план готов', className: 'active', note: `запланировано ${planned} из ${requested}` };
	if (planned > 0) return { label: 'в плане', className: 'draft', note: `запланировано ${planned} из ${requested}` };
	return { label: statusLabel(order.status, order.closed), className: /pending/i.test(order.status) ? 'draft' : 'active', note: 'еще не разбирали' };
};
const transferStatusLabel = (status: string): string => {
	if (status === 'requested') return 'создано';
	if (status === 'in_transit') return 'в пути';
	if (status === 'received') return 'получено';
	if (status === 'shortage') return 'недовоз';
	if (status === 'canceled') return 'отменено';
	return status || 'в работе';
};
const childStatusClass = (status: string): string => {
	if (status === 'received' || /completed|closed|to receive/i.test(status)) return 'done';
	if (status === 'shortage') return 'active';
	return 'draft';
};
const linesSummary = (lines: TransferLineDto[]): string =>
	lines.map((line) => `${line.name || `#${line.productId}`}: ${line.qty} шт`).join(', ');
const receiptLinesSummary = (lines: TransferLineDto[]): string =>
	lines.map((line) => `${line.name || `#${line.productId}`}: ${line.qty} шт${line.warehouse ? ` · ${line.warehouse}` : ''}`).join(', ');
const money = (value: number): string => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
const purchaseReceivedQty = (purchase: SupplyPurchaseChild, productId: number): number =>
	purchase.receipts.reduce((sum, receipt) => sum + receipt.lines.filter((line) => line.productId === productId).reduce((a, line) => a + line.qty, 0), 0);
const purchaseOrderedQty = (purchase: SupplyPurchaseChild): number => purchase.lines.reduce((sum, line) => sum + line.qty, 0);
const purchaseReceivedTotal = (purchase: SupplyPurchaseChild): number =>
	purchase.lines.reduce((sum, line) => sum + Math.min(purchaseReceivedQty(purchase, line.productId), line.qty), 0);
const purchaseTotal = (purchase: SupplyPurchaseChild): number =>
	Number(purchase.total ?? 0) || purchase.lines.reduce((sum, line) => sum + line.qty * Number(line.rate ?? 0), 0);
const effectivePurchaseStage = (purchase: SupplyPurchaseChild): SupplyPurchaseStage | 'partial' | 'received' => {
	const ordered = purchaseOrderedQty(purchase);
	const received = purchaseReceivedTotal(purchase);
	if (/cancel/i.test(purchase.status) || purchase.supplyStage === 'cancelled') return 'cancelled';
	if (ordered > 0 && received >= ordered) return 'received';
	if (received > 0) return 'partial';
	const stage = String(purchase.supplyStage ?? '').trim();
	if (stage === 'approval' || stage === 'approved' || stage === 'ordered' || stage === 'draft') return stage;
	if (/ordered|to receive|submitted/i.test(purchase.status)) return 'ordered';
	return 'draft';
};
const supplierRequestStatus = (purchase: SupplyPurchaseChild): { label: string; className: string } => {
	const stage = effectivePurchaseStage(purchase);
	if (stage === 'cancelled') return { label: 'отменено', className: 'draft' };
	if (stage === 'received') return { label: 'получено', className: 'done' };
	if (stage === 'partial') return { label: 'частично пришло', className: 'active' };
	if (stage === 'ordered') return { label: 'ожидаем поставку', className: 'active' };
	if (stage === 'approved') return { label: 'согласовано', className: 'active' };
	if (stage === 'approval') return { label: 'на согласовании', className: 'active' };
	return { label: 'черновик', className: 'draft' };
};
const nextPurchaseAction = (purchase: SupplyPurchaseChild): { label: string; stage?: SupplyPurchaseStage; receive?: boolean } | null => {
	const stage = effectivePurchaseStage(purchase);
	if (stage === 'draft') return { label: 'На согласование', stage: 'approval' };
	if (stage === 'approval') return { label: 'Согласовано', stage: 'approved' };
	if (stage === 'approved') return { label: 'Заказано', stage: 'ordered' };
	if (stage === 'ordered' || stage === 'partial') return { label: 'Оприходовать', receive: true };
	return null;
};
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
function printHtml(title: string, body: string): void {
	const w = window.open('', '_blank', 'width=980,height=760');
	if (!w) return;
	w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
		body{font-family:Arial,sans-serif;color:#111827;margin:32px}
		h1{font-size:22px;margin:0 0 8px} h2{font-size:16px;margin:24px 0 8px}
		.meta{color:#4b5563;margin-bottom:18px;font-size:13px}
		table{width:100%;border-collapse:collapse;margin-top:12px} th,td{border:1px solid #d1d5db;padding:8px;text-align:left;font-size:12px}
		th{background:#f3f4f6} .num{text-align:right}.total{font-weight:700}.muted{color:#6b7280}
		.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:42px}.line{border-top:1px solid #111827;padding-top:8px}
		@media print{button{display:none} body{margin:18mm}}
	</style></head><body>${body}<button onclick="window.print()">Печать</button></body></html>`);
	w.document.close();
}
function printSupplierRequest(order: SupplyOrderRow, purchase: SupplyPurchaseChild): void {
	const rows = purchase.lines.map((line, index) => {
		const received = purchaseReceivedQty(purchase, line.productId);
		const remaining = Math.max(line.qty - received, 0);
		const rate = Number(line.rate ?? 0);
		return `<tr><td>${index + 1}</td><td>${escapeHtml(line.name || `#${line.productId}`)}</td><td class="num">${line.qty}</td><td class="num">${money(rate)}</td><td class="num">${money(rate * line.qty)}</td><td class="num">${received}</td><td class="num">${remaining}</td></tr>`;
	}).join('');
	const total = purchase.lines.reduce((sum, line) => sum + line.qty * Number(line.rate ?? 0), 0);
	printHtml(`Заявка поставщику ${purchase.name}`, `<h1>Заявка поставщику ${escapeHtml(purchase.name)}</h1><div class="meta">Поставщик: ${escapeHtml(purchase.supplier || DEFAULT_SUPPLIER)}<br>Заявка снабжения: ${escapeHtml(order.name)} · Сделка #${escapeHtml(order.dealId)} · Склад: ${escapeHtml(order.toStore || '-')}</div><table><thead><tr><th>#</th><th>Позиция</th><th class="num">Заказано</th><th class="num">Цена</th><th class="num">Сумма</th><th class="num">Получено</th><th class="num">Остаток</th></tr></thead><tbody>${rows}<tr class="total"><td colspan="4">Итого</td><td class="num">${money(total)}</td><td></td><td></td></tr></tbody></table><div class="sign"><div class="line">Снабжение</div><div class="line">Согласовано</div></div>`);
}
function printSupplierSummary(order: SupplyOrderRow): void {
	const purchases = order.purchases ?? [];
	const rows = purchases.flatMap((purchase) => purchase.lines.map((line) => ({ purchase, line }))).map(({ purchase, line }, index) => {
		const rate = Number(line.rate ?? 0);
		return `<tr><td>${index + 1}</td><td>${escapeHtml(purchase.supplier || DEFAULT_SUPPLIER)}</td><td>${escapeHtml(line.name || `#${line.productId}`)}</td><td class="num">${line.qty}</td><td class="num">${money(rate)}</td><td class="num">${money(rate * line.qty)}</td></tr>`;
	}).join('');
	const total = purchases.reduce((sum, purchase) => sum + purchase.lines.reduce((a, line) => a + line.qty * Number(line.rate ?? 0), 0), 0);
	printHtml(`Сводная заявка ${order.name}`, `<h1>Сводная заявка поставщикам</h1><div class="meta">Заявка снабжения: ${escapeHtml(order.name)} · Сделка #${escapeHtml(order.dealId)} · Склад: ${escapeHtml(order.toStore || '-')}</div><table><thead><tr><th>#</th><th>Поставщик</th><th>Позиция</th><th class="num">Кол-во</th><th class="num">Цена</th><th class="num">Сумма</th></tr></thead><tbody>${rows}<tr class="total"><td colspan="5">Итого</td><td class="num">${money(total)}</td></tr></tbody></table>`);
}

function PurchaseInlineDetails({ purchase }: { purchase: SupplyPurchaseChild }): JSX.Element {
	return (
		<div className="supply-tree-details">
			<div className="supply-purchase-lines">
				<div className="supply-purchase-line head"><span>Позиция</span><span>Заказано</span><span>Получено</span><span>Остаток</span><span>Цена</span><span>Сумма</span></div>
				{purchase.lines.map((line) => {
					const received = purchaseReceivedQty(purchase, line.productId);
					const rate = Number(line.rate ?? 0);
					return (
						<div key={line.productId} className="supply-purchase-line">
							<span><b>{line.name || `#${line.productId}`}</b><small>#{line.productId}</small></span>
							<span>{line.qty}</span>
							<span>{received}</span>
							<span>{Math.max(line.qty - received, 0)}</span>
							<span>{money(rate)} ₽</span>
							<span>{money(rate * line.qty)} ₽</span>
						</div>
					);
				})}
			</div>
			<div className="supply-tree-receipts">
				{purchase.receipts.length === 0 ? (
					<span>Приходов пока нет</span>
				) : purchase.receipts.map((receipt) => (
					<div key={receipt.name}>
						<b>Оприходование {receipt.name}</b>
						<small>{receiptLinesSummary(receipt.lines)}</small>
					</div>
				))}
			</div>
		</div>
	);
}

function SupplyOrderTree({ order, docsBusy, onOpenOrder, onReceivePurchase, onUpdatePurchaseStage, onCreateReceiptTransfer }: {
	order: SupplyOrderRow;
	docsBusy: boolean;
	onOpenOrder?: (order: SupplyOrderRow) => void;
	onReceivePurchase: (purchase: SupplyPurchaseChild) => void;
	onUpdatePurchaseStage: (purchase: SupplyPurchaseChild, stage: SupplyPurchaseStage) => void;
	onCreateReceiptTransfer?: (order: SupplyOrderRow, purchase: SupplyPurchaseChild, receipt: SupplyPurchaseChild['receipts'][number]) => void;
}): JSX.Element {
	const [expandedPurchase, setExpandedPurchase] = useState<string | null>(null);
	const view = orderStatusView(order);
	const docsCount = supplyDocumentCount(order);
	const connector = () => (
		<svg className="supply-tree-connector" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
			<path d="M4 0 V22 Q4 34 16 34 H44" />
		</svg>
	);
	return (
		<div className="supply-tree">
			<div className="supply-tree-node root">
				<div>
					<b>{order.name} · {order.dealTitle || `Сделка #${order.dealId}`}</b>
					<small>Сделка #{order.dealId} · склад заявки: {order.toStore || '-'} · документов: {docsCount}</small>
				</div>
				<div className="supply-linked-actions">
					<i className={`supply-status ${view.className}`}>{view.label}</i>
					{onOpenOrder && <button type="button" onClick={() => onOpenOrder(order)}>Открыть заявку</button>}
				</div>
			</div>
			<div className="supply-tree-children">
				{(order.purchases ?? []).map((purchase) => {
					const status = supplierRequestStatus(purchase);
					const ordered = purchaseOrderedQty(purchase);
					const received = purchaseReceivedTotal(purchase);
					const isExpanded = expandedPurchase === purchase.name;
					const action = nextPurchaseAction(purchase);
					return (
						<div key={`tree-purchase-${purchase.name}`} className="supply-tree-branch">
							{connector()}
							<div className="supply-tree-node purchase">
								<div>
									<b>Заказ {purchase.name} · {purchase.supplier || DEFAULT_SUPPLIER}</b>
									<small>Заказано {ordered} · получено {received} · остаток {Math.max(ordered - received, 0)} · {purchase.lines.length} {plural(purchase.lines.length, 'позиция', 'позиции', 'позиций')}</small>
								</div>
								<div className="supply-linked-actions">
									<i className={`supply-status ${status.className}`}>{status.label}</i>
									<button type="button" onClick={() => setExpandedPurchase(isExpanded ? null : purchase.name)}>{isExpanded ? 'Свернуть' : 'Детали'}</button>
									<button type="button" onClick={() => printSupplierRequest(order, purchase)}>Печать</button>
									{action?.stage && <button type="button" disabled={docsBusy} onClick={() => onUpdatePurchaseStage(purchase, action.stage!)}>{action.label}</button>}
									{action?.receive && <button type="button" disabled={docsBusy} onClick={() => onReceivePurchase(purchase)}>{action.label}</button>}
								</div>
							</div>
							{isExpanded && <PurchaseInlineDetails purchase={purchase} />}
							{purchase.receipts.map((receipt) => (
								<div key={`tree-receipt-${receipt.name}`} className="supply-tree-node receipt">
									{connector()}
									<div>
										<b>Оприходование {receipt.name}</b>
										<small>{receiptLinesSummary(receipt.lines)}</small>
									</div>
									<div className="supply-linked-actions">
										<i className={`supply-status ${childStatusClass(receipt.status)}`}>{receipt.status || 'получено'}</i>
										{onCreateReceiptTransfer && receipt.lines.some((line) => line.warehouse && line.warehouse !== order.toStore) && (
											<button type="button" disabled={docsBusy} onClick={() => onCreateReceiptTransfer(order, purchase, receipt)}>На точку</button>
										)}
									</div>
								</div>
							))}
						</div>
					);
				})}
				{(order.transfers ?? []).map((doc) => (
					<div key={`tree-transfer-${doc.id || doc.name}`} className="supply-tree-node transfer">
						{connector()}
						<div>
							<b>Перемещение на точку с другой точки · {doc.name || `#${doc.id}`}</b>
							<small>{doc.fromStore || 'склад отправки'} → {doc.toStore || order.toStore || 'склад получения'} · {linesSummary(doc.lines)}</small>
							{doc.status === 'shortage' && doc.shortageLines.length > 0 && <em>Недовоз: {linesSummary(doc.shortageLines)}</em>}
						</div>
						<i className={`supply-status ${childStatusClass(doc.status)}`}>{transferStatusLabel(doc.status)}</i>
					</div>
				))}
				{docsCount === 0 && <div className="supply-tree-empty">{connector()}Документы по заявке еще не созданы.</div>}
			</div>
		</div>
	);
}

const itemKey = (orderName: string, productId: number, index: number): string => `${orderName}:${productId}:${index}`;
const stockEntries = (item: SupplyOrderItem): Array<[string, number]> =>
	Object.entries(item.stocks ?? {}).filter(([, qty]) => Number(qty) > 0).sort((a, b) => b[1] - a[1]);

function OrdersList({ orders, decisions, loading, selectedName, onPreview, onOpen }: {
	orders: SupplyOrderRow[];
	decisions: DecisionMap;
	loading: boolean;
	selectedName: string | null;
	onPreview: (order: SupplyOrderRow) => void;
	onOpen: (order: SupplyOrderRow) => void;
}): JSX.Element {
	return (
		<section className="supply-card supply-orders">
			<div className="supply-card-head">
				<div>
					<h2>Очередь заявок</h2>
					<p>Клик по заявке открывает рабочее окно распределения.</p>
				</div>
				<span className="supply-muted">обновляется из ядра</span>
			</div>
			<div className="supply-table supply-orders-table">
				<div className="supply-tr supply-th">
					<span>Заявка</span><span>Сделка</span><span>Позиций</span><span>Статус</span><span>Дата</span>
				</div>
				{loading && <div className="supply-empty">Загрузка заявок из ядра...</div>}
				{!loading && !orders.length && <div className="supply-empty">Заявок пока нет.</div>}
				{orders.map((order) => {
					const view = orderStatusView(order, decisions);
					return (
						<button
							key={order.name}
							className={`supply-tr supply-order-row ${selectedName === order.name ? 'is-selected' : ''}`}
							onMouseEnter={() => onPreview(order)}
							onFocus={() => onPreview(order)}
							onClick={() => onOpen(order)}
							type="button"
						>
							<span><b>{order.name}</b><small>{order.date}</small></span>
							<span><b>{order.dealTitle || `Сделка #${order.dealId}`}</b><small>{order.toStore || `#${order.dealId}`}</small></span>
							<span>{requestItemsForOrder(order).length} {plural(requestItemsForOrder(order).length, 'позиция', 'позиции', 'позиций')}<small>{view.note}</small></span>
							<span><i className={`supply-status ${view.className}`}>{view.label}</i></span>
							<span>{order.date || '-'}</span>
						</button>
					);
				})}
			</div>
		</section>
	);
}

function PreviewPanel({ order, decisions }: { order: SupplyOrderRow | null; decisions: DecisionMap }): JSX.Element {
	if (!order) {
		return (
			<aside className="supply-card supply-preview">
				<h2>Быстрый просмотр</h2>
				<p className="supply-muted">Наведи на заявку, чтобы увидеть состав.</p>
		</aside>
	);
}
	const view = orderStatusView(order, decisions);
	return (
		<aside className="supply-card supply-preview">
			<div className="supply-preview-title">
				<div>
					<h2>{order.name}</h2>
					<p>{order.dealTitle || `Сделка #${order.dealId}`}</p>
				</div>
				<i className={`supply-status ${view.className}`}>{view.label}</i>
			</div>
			<div className="supply-preview-meta">
				<span>Сделка #{order.dealId}</span>
				<span>{order.toStore || 'склад не указан'}</span>
				<span>{order.date || 'без даты'}</span>
				<span>{requestItemsForOrder(order).length} {plural(requestItemsForOrder(order).length, 'позиция', 'позиции', 'позиций')}</span>
			</div>
			<div className="supply-preview-items">
				{requestItemsForOrder(order).map((item, index) => {
					const stocks = stockEntries(item);
					return (
						<div key={`${item.productId}-${index}`} className="supply-preview-item">
							<b>{item.itemName || `#${item.productId}`}</b>
							<span>нужно {item.qty} шт</span>
							<small>{stocks.length ? `есть ${stocks.reduce((a, [, q]) => a + q, 0)} на ${stocks.length} ${plural(stocks.length, 'складе', 'складах', 'складах')}` : 'нет на складах'}</small>
						</div>
					);
				})}
			</div>
			<p className="supply-preview-hint">Рабочее окно открывается кликом по заявке в списке.</p>
		</aside>
	);
}

type PurchaseFilter = 'all' | SupplyPurchaseStage | 'partial' | 'received';
const PURCHASE_FILTERS: Array<{ key: PurchaseFilter; label: string }> = [
	{ key: 'all', label: 'Все' },
	{ key: 'draft', label: 'Черновики' },
	{ key: 'approval', label: 'На согласовании' },
	{ key: 'approved', label: 'Согласовано' },
	{ key: 'ordered', label: 'Ожидаем' },
	{ key: 'partial', label: 'Частично пришло' },
	{ key: 'received', label: 'Получено' },
];

function PurchasesSection({ orders, loading, docsBusy, onOpenOrder, onReceivePurchase, onUpdatePurchaseStage, onCreateReceiptTransfer }: {
	orders: SupplyOrderRow[];
	loading: boolean;
	docsBusy: boolean;
	onOpenOrder: (order: SupplyOrderRow) => void;
	onReceivePurchase: (purchase: SupplyPurchaseChild) => void;
	onUpdatePurchaseStage: (purchase: SupplyPurchaseChild, stage: SupplyPurchaseStage) => void;
	onCreateReceiptTransfer: (order: SupplyOrderRow, purchase: SupplyPurchaseChild, receipt: SupplyPurchaseChild['receipts'][number]) => void;
}): JSX.Element {
	const [filter, setFilter] = useState<PurchaseFilter>('all');
	const treeOrders = orders.filter((order) => (order.purchases?.length ?? 0) > 0 || (order.transfers?.length ?? 0) > 0);
	const purchaseRows = orders.flatMap((order) => (order.purchases ?? []).map((purchase) => ({ order, purchase, stage: effectivePurchaseStage(purchase) })));
	const filteredRows = filter === 'all' ? purchaseRows : purchaseRows.filter((row) => row.stage === filter);
	const docs = treeOrders.reduce((sum, order) => sum + supplyDocumentCount(order), 0);
	return (
		<>
			<section className="supply-card supply-purchase-board">
				<div className="supply-card-head">
					<div>
						<h2>Журнал закупок</h2>
						<p>Рабочая очередь снабжения: согласование, заказ поставщику и ожидание прихода.</p>
					</div>
					<span className="supply-muted">{purchaseRows.length} {plural(purchaseRows.length, 'заказ', 'заказа', 'заказов')}</span>
				</div>
				<div className="supply-purchase-filters">
					{PURCHASE_FILTERS.map((item) => <button key={item.key} className={filter === item.key ? 'active' : ''} type="button" onClick={() => setFilter(item.key)}>{item.label}</button>)}
				</div>
				<div className="supply-purchase-board-list">
					{loading && <div className="supply-empty">Загрузка закупок из ядра...</div>}
					{!loading && filteredRows.length === 0 && <div className="supply-empty">В этом статусе закупок пока нет.</div>}
					{filteredRows.map(({ order, purchase }) => {
						const status = supplierRequestStatus(purchase);
						const action = nextPurchaseAction(purchase);
						const ordered = purchaseOrderedQty(purchase);
						const received = purchaseReceivedTotal(purchase);
						return (
							<div key={`${order.name}-${purchase.name}`} className="supply-purchase-board-row">
								<div>
									<b>{purchase.name} · {purchase.supplier || DEFAULT_SUPPLIER}</b>
									<small>{order.name} · сделка #{order.dealId} · склад: {order.toStore || '-'}</small>
								</div>
								<span><i className={`supply-status ${status.className}`}>{status.label}</i></span>
								<span>{ordered} / {received}<small>заказано / пришло</small></span>
								<span>{money(purchaseTotal(purchase))} ₽<small>{purchase.expectedAt ? `ожидаем ${purchase.expectedAt}` : 'без даты'}</small></span>
								<div className="supply-linked-actions">
									<button type="button" onClick={() => onOpenOrder(order)}>Заявка</button>
									{action?.stage && <button type="button" disabled={docsBusy} onClick={() => onUpdatePurchaseStage(purchase, action.stage!)}>{action.label}</button>}
									{action?.receive && <button type="button" disabled={docsBusy} onClick={() => onReceivePurchase(purchase)}>{action.label}</button>}
								</div>
							</div>
						);
					})}
				</div>
			</section>
			<section className="supply-card supply-linked-docs">
				<div className="supply-card-head">
					<div>
						<h2>Дерево заявок</h2>
						<p>Заявка сверху, ниже закупки и перемещения, созданные из нее.</p>
					</div>
					<span className="supply-muted">{docs} {plural(docs, 'документ', 'документа', 'документов')}</span>
				</div>
				<div className="supply-tree-list">
					{loading && <div className="supply-empty">Загрузка закупок из ядра...</div>}
					{!loading && treeOrders.length === 0 && <div className="supply-empty">Документов пока нет. Они появятся здесь после создания закупок или перемещений из заявки снабжения.</div>}
					{treeOrders.map((order) => <SupplyOrderTree key={order.name} order={order} docsBusy={docsBusy} onOpenOrder={onOpenOrder} onReceivePurchase={onReceivePurchase} onUpdatePurchaseStage={onUpdatePurchaseStage} onCreateReceiptTransfer={onCreateReceiptTransfer} />)}
				</div>
			</section>
		</>
	);
}

function LogisticsSection({ orders, loading, onOpenOrder }: { orders: SupplyOrderRow[]; loading: boolean; onOpenOrder: (order: SupplyOrderRow) => void }): JSX.Element {
	const rows = orders.flatMap((order) => (order.transfers ?? []).map((transfer) => ({ order, transfer })));
	return (
		<section className="supply-card supply-docs-board">
			<div className="supply-card-head">
				<div>
					<h2>Перемещения</h2>
					<p>Все перемещения, созданные из заявок снабжения.</p>
				</div>
				<span className="supply-muted">{rows.length} {plural(rows.length, 'документ', 'документа', 'документов')}</span>
			</div>
			<div className="supply-docs-list">
				{loading && <div className="supply-empty">Загрузка перемещений из ядра...</div>}
				{!loading && rows.length === 0 && <div className="supply-empty">Перемещений по заявкам пока нет.</div>}
				{rows.map(({ order, transfer }) => (
					<div key={`${order.name}-${transfer.id || transfer.name}`} className="supply-doc-row">
						<div>
							<b>{transfer.name || `Перемещение #${transfer.id}`}</b>
							<small>{order.name} · сделка #{order.dealId} · {transfer.fromStore || 'склад отправки'} → {transfer.toStore || order.toStore || 'склад получения'}</small>
							<em>{linesSummary(transfer.lines)}</em>
							{transfer.status === 'shortage' && transfer.shortageLines.length > 0 && <em>Недовоз: {linesSummary(transfer.shortageLines)}</em>}
						</div>
						<div className="supply-linked-actions">
							<i className={`supply-status ${childStatusClass(transfer.status)}`}>{transferStatusLabel(transfer.status)}</i>
							<button type="button" onClick={() => onOpenOrder(order)}>Заявка</button>
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

function StockDocumentsSection({ orders, loading, onOpenOrder }: { orders: SupplyOrderRow[]; loading: boolean; onOpenOrder: (order: SupplyOrderRow) => void }): JSX.Element {
	const receiptRows = orders.flatMap((order) => (order.purchases ?? []).flatMap((purchase) => purchase.receipts.map((receipt) => ({ order, purchase, receipt }))));
	const transferRows = orders.flatMap((order) => (order.transfers ?? []).map((transfer) => ({ order, transfer })));
	const total = receiptRows.length + transferRows.length;
	return (
		<section className="supply-card supply-docs-board">
			<div className="supply-card-head">
				<div>
					<h2>Складские документы</h2>
					<p>Оприходования и перемещения, которые объясняют закрытие заявок.</p>
				</div>
				<span className="supply-muted">{total} {plural(total, 'документ', 'документа', 'документов')}</span>
			</div>
			<div className="supply-docs-list">
				{loading && <div className="supply-empty">Загрузка складских документов из ядра...</div>}
				{!loading && total === 0 && <div className="supply-empty">Складских документов по заявкам пока нет.</div>}
				{receiptRows.map(({ order, purchase, receipt }) => (
					<div key={`${order.name}-${purchase.name}-${receipt.name}`} className="supply-doc-row">
						<div>
							<b>Оприходование {receipt.name}</b>
							<small>{order.name} · заказ {purchase.name} · {purchase.supplier || DEFAULT_SUPPLIER}</small>
							<em>{receiptLinesSummary(receipt.lines)}</em>
						</div>
						<div className="supply-linked-actions">
							<i className={`supply-status ${childStatusClass(receipt.status)}`}>{receipt.status || 'получено'}</i>
							<button type="button" onClick={() => onOpenOrder(order)}>Заявка</button>
						</div>
					</div>
				))}
				{transferRows.map(({ order, transfer }) => (
					<div key={`${order.name}-${transfer.id || transfer.name}`} className="supply-doc-row">
						<div>
							<b>Перемещение {transfer.name || `#${transfer.id}`}</b>
							<small>{order.name} · {transfer.fromStore || 'склад отправки'} → {transfer.toStore || order.toStore || 'склад получения'}</small>
							<em>{linesSummary(transfer.lines)}</em>
						</div>
						<div className="supply-linked-actions">
							<i className={`supply-status ${childStatusClass(transfer.status)}`}>{transferStatusLabel(transfer.status)}</i>
							<button type="button" onClick={() => onOpenOrder(order)}>Заявка</button>
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

function OrderDetail({ order, decisions, drafts, docsBusy, onBack, setDraft, addDecision, removeDecision, createDocs, onReceivePurchase, onUpdatePurchaseStage, onCreateReceiptTransfer }: {
	order: SupplyOrderRow;
	decisions: DecisionMap;
	drafts: DraftInput;
	docsBusy: boolean;
	onBack: () => void;
	setDraft: (key: string, patch: Partial<DraftInput[string]>) => void;
	addDecision: (key: string, item: SupplyOrderItem, index: number) => void;
	removeDecision: (key: string, id: string) => void;
	createDocs: () => void;
	onReceivePurchase: (purchase: SupplyPurchaseChild) => void;
	onUpdatePurchaseStage: (purchase: SupplyPurchaseChild, stage: SupplyPurchaseStage) => void;
	onCreateReceiptTransfer: (order: SupplyOrderRow, purchase: SupplyPurchaseChild, receipt: SupplyPurchaseChild['receipts'][number]) => void;
}): JSX.Element {
	const requestItems = requestItemsForOrder(order);
	const requestedTotal = requestItems.reduce((sum, item) => sum + item.qty, 0);
	const plannedTotal = order.items.reduce((sum, item, index) => {
		const key = itemKey(order.name, item.productId, index);
		return sum + (decisions[key] ?? []).reduce((a, d) => a + d.qty, 0);
	}, 0);
	const remainingTotals = order.items.reduce((sum, item) => sum + item.qty, 0);
	const allDone = remainingTotals > 0 && plannedTotal >= remainingTotals;
	const existingDocs = supplyDocumentCount(order);
	const plannedTransfers = Object.values(decisions).flat().filter((row) => row.kind === 'transfer').reduce((sum, row) => sum + row.qty, 0);
	const plannedPurchases = Object.values(decisions).flat().filter((row) => row.kind === 'purchase').reduce((sum, row) => sum + row.qty, 0);
	const nextAction = remainingTotals === 0 ? 'Остаток закрыт документами' : allDone ? 'Можно создать перемещения и заявки поставщикам' : `Распредели еще ${Math.max(remainingTotals - plannedTotal, 0)} шт`;

	return (
		<div className="supply-main supply-detail">
			<header className="supply-top">
				<div>
					<button className="supply-link" type="button" onClick={onBack}>Назад к заявкам</button>
					<h1>{order.name} · {order.dealTitle || `Сделка #${order.dealId}`}</h1>
					<p>Сделка #{order.dealId} · Получить на склад: {order.toStore || 'не указан'} · {order.date || 'без даты'}</p>
				</div>
				<button className="supply-primary" type="button" disabled={!allDone || docsBusy} onClick={createDocs}>{docsBusy ? 'Создаем...' : 'Создать документы'}</button>
			</header>

			<section className="supply-card supply-flow">
				<div className="supply-flow-step">
					<span>1. Потребность</span>
					<b>{requestedTotal} шт в {requestItems.length} позициях</b>
					<small>Это то, что запросила сделка.</small>
				</div>
				<div className="supply-flow-step">
					<span>2. План закрытия</span>
					<b>{plannedTotal} из {remainingTotals} шт выбрано</b>
					<small>{plannedTransfers > 0 ? `Переместить: ${plannedTransfers} шт. ` : ''}{plannedPurchases > 0 ? `Купить: ${plannedPurchases} шт.` : 'Ниже выбери перемещение или закупку.'}</small>
				</div>
				<div className="supply-flow-step">
					<span>3. Следующее действие</span>
					<b>{nextAction}</b>
					<small>{existingDocs > 0 ? `Уже создано документов: ${existingDocs}.` : 'Документы появятся ниже после создания.'}</small>
				</div>
			</section>

			{existingDocs > 0 && (
				<section className="supply-card supply-linked-docs">
					<div className="supply-card-head">
						<div>
							<h2>Документы по заявке</h2>
							<p>Перемещения и закупки, созданные из этой заявки.</p>
						</div>
						<div className="supply-doc-head-actions">
							<span className="supply-muted">{existingDocs} {plural(existingDocs, 'документ', 'документа', 'документов')}</span>
							{(order.purchases?.length ?? 0) > 1 && <button type="button" onClick={() => printSupplierSummary(order)}>Сводная печать</button>}
						</div>
					</div>
					<div className="supply-tree-list">
						<SupplyOrderTree order={order} docsBusy={docsBusy} onReceivePurchase={onReceivePurchase} onUpdatePurchaseStage={onUpdatePurchaseStage} onCreateReceiptTransfer={onCreateReceiptTransfer} />
					</div>
				</section>
			)}

			<section className="supply-card supply-detail-table">
				<div className="supply-card-head supply-work-head">
					<div>
						<h2>Что сделать с остатком</h2>
						<p>По каждой строке выбери: забрать с другой точки или создать заявку поставщику. Закупку можно ставить больше потребности, заявка на сделку от этого не переполнится.</p>
					</div>
				</div>
				{order.items.length === 0 && <div className="supply-empty">Остатка по заявке нет. Ниже уже нечего распределять, смотри созданные документы выше.</div>}
				{order.items.map((item, index) => {
					const key = itemKey(order.name, item.productId, index);
					const rows = decisions[key] ?? [];
					const used = rows.reduce((a, d) => a + d.qty, 0);
					const remaining = Math.max(item.qty - used, 0);
					const stocks = stockEntries(item);
					const draft = drafts[key] ?? { qty: remaining || 1, kind: stocks.length ? 'transfer' : 'purchase', warehouse: stocks[0]?.[0] ?? '', supplier: '', rate: 0 };
					const selectedWarehouse = draft.warehouse || stocks[0]?.[0] || '';
					const stockOptions = stocks.map(([name, qty]) => {
						const planned = rows
							.filter((row) => row.kind === 'transfer' && row.warehouse === name)
							.reduce((sum, row) => sum + row.qty, 0);
						return { name, qty, available: Math.max(qty - planned, 0) };
					});
					const selectedStock = stockOptions.find((stock) => stock.name === selectedWarehouse);
					const transferLimit = Math.max(Math.min(remaining, selectedStock?.available ?? remaining), 0);
					return (
						<div key={key} className="supply-item-block">
							<div className={`supply-detail-row ${remaining === 0 ? 'is-done' : ''}`}>
								<div className="supply-need-cell">
									<b>{item.itemName || `#${item.productId}`}</b>
									<small>{item.note || 'строка из заявки'}</small>
								</div>
								<div className="supply-remaining-cell">
									<span>Осталось решить</span>
									<strong>{remaining} из {item.qty}</strong>
								</div>
								<div className="supply-stock-cell">
									<span>Наличие</span>
									<b>{stocks.length ? `${stocks.reduce((a, [, q]) => a + q, 0)} шт` : 'нет'}</b>
									<small>{stocks.length ? stocks.map(([name, qty]) => `${name}: ${qty}`).join(', ') : 'нужно закупать'}</small>
								</div>
								{remaining > 0 ? (
									<>
										<div className="supply-plan-cell">
											<label>
												<span>Количество</span>
												<input type="number" min={draft.kind === 'transfer' && transferLimit === 0 ? '0' : '1'} max={draft.kind === 'transfer' ? transferLimit : undefined} value={draft.kind === 'transfer' ? (transferLimit > 0 ? Math.min(draft.qty, transferLimit) : 0) : draft.qty} onChange={(e) => setDraft(key, { qty: Number(e.target.value) })} />
											</label>
											<label>
												<span>Решение</span>
												<select value={draft.kind} onChange={(e) => setDraft(key, { kind: e.target.value as DecisionKind })}>
													<option value="transfer">Переместить</option>
													<option value="purchase">Купить</option>
												</select>
											</label>
											{draft.kind === 'purchase' ? (
												<div className="supply-purchase-fields">
													<label>
														<span>Поставщик</span>
														<input type="text" list="supply-suppliers" placeholder="Начни вводить поставщика" value={draft.supplier} onChange={(e) => setDraft(key, { supplier: e.target.value })} />
													</label>
													<label>
														<span>Цена</span>
														<input type="number" min="0" step="any" placeholder="0" value={draft.rate} onChange={(e) => setDraft(key, { rate: Number(e.target.value) })} />
													</label>
												</div>
											) : (
												<label className="supply-wide-field">
													<span>Склад отправки</span>
													<select value={selectedWarehouse} onChange={(e) => setDraft(key, { warehouse: e.target.value })}>
														{stockOptions.map(({ name, qty, available }) => <option key={name} value={name}>{name} (доступно {available} из {qty})</option>)}
													</select>
												</label>
											)}
											<div className="supply-plan-actions">
												<button className="supply-primary small" type="button" onClick={() => addDecision(key, item, index)}>Добавить в план</button>
											</div>
										</div>
									</>
								) : (
									<div className="supply-plan-cell is-complete">
										<i className="supply-status done">готово</i>
									</div>
								)}
							</div>
							{rows.map((row) => (
								<div key={row.id} className="supply-child-row">
									<span>{row.kind === 'transfer' ? 'Перемещение' : 'Заявка поставщику'} · {row.qty} шт · {row.kind === 'transfer' ? `${row.warehouse ?? ''} → ${order.toStore || 'склад назначения'}` : `${row.supplier || DEFAULT_SUPPLIER} · ${row.rate ?? 0} ₽`}</span>
									<i className="supply-status draft">черновик</i>
									<button type="button" onClick={() => removeDecision(key, row.id)}>удалить</button>
								</div>
							))}
						</div>
					);
				})}
			</section>
		</div>
	);
}

export function Supply(): JSX.Element {
	const ctx = getContext();
	const [phase, setPhase] = useState<'init' | 'denied' | 'ready'>('init');
	const [section, setSection] = useState<SectionKey>('orders');
	const [orders, setOrders] = useState<SupplyOrderRow[]>(ctx.__mock ? MOCK_ORDERS : []);
	const [loadingOrders, setLoadingOrders] = useState(!ctx.__mock);
	const [previewName, setPreviewName] = useState<string | null>(ctx.__mock ? MOCK_ORDERS[0]?.name ?? null : null);
	const [detailName, setDetailName] = useState<string | null>(null);
	const [decisions, setDecisions] = useState<DecisionMap>({});
	const [drafts, setDrafts] = useState<DraftInput>({});
	const [notice, setNotice] = useState<string | null>(null);
	const [docsBusy, setDocsBusy] = useState(false);
	const [receivingPurchase, setReceivingPurchase] = useState<SupplyPurchaseChild | null>(null);
	const [receivingOrderName, setReceivingOrderName] = useState<string | null>(null);
	const [receiveDraft, setReceiveDraft] = useState<ReceiveDraft>({});
	const [receiveStore, setReceiveStore] = useState(DEFAULT_RECEIPT_STORE);
	const [suppliers, setSuppliers] = useState<string[]>([]);

	const refreshOrders = useCallback(async (silent = false): Promise<void> => {
		if (ctx.__mock) return;
		if (!silent) setLoadingOrders(true);
		try {
			const loaded = await fetchSupplyOrders();
			setOrders(loaded);
			setPreviewName((current) => current && loaded.some((o) => o.name === current) ? current : loaded[0]?.name ?? null);
			setDetailName((current) => current && loaded.some((o) => o.name === current) ? current : null);
		} catch {
			if (!silent) setOrders([]);
		} finally {
			if (!silent) setLoadingOrders(false);
		}
	}, [ctx.__mock]);

	useEffect(() => {
		if (ctx.__mock) { setPhase('ready'); return; }
		const bx = window.BX24;
		if (!bx) { setPhase('ready'); return; }
		bx.init(() => {
			void (async () => {
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				if (!isPortalAdmin() && !BETA_USER_IDS.includes(uid)) { setPhase('denied'); return; }
				setPhase('ready');
				await refreshOrders();
			})().catch(() => setPhase('denied'));
		});
	}, [ctx.__mock, refreshOrders]);

	useEffect(() => {
		if (ctx.__mock || phase !== 'ready' || section !== 'orders') return;
		const timer = window.setInterval(() => { void refreshOrders(true); }, 10000);
		return () => window.clearInterval(timer);
	}, [ctx.__mock, phase, refreshOrders, section]);

	useEffect(() => {
		if (ctx.__mock || phase !== 'ready') return;
		void fetchSupplySuppliers().then(setSuppliers).catch(() => setSuppliers([]));
	}, [ctx.__mock, phase]);

	const selectedPreview = useMemo(() => orders.find((o) => o.name === previewName) ?? orders[0] ?? null, [orders, previewName]);
	const detailOrder = useMemo(() => orders.find((o) => o.name === detailName) ?? null, [orders, detailName]);
	const grouped = SECTIONS.reduce<Record<string, typeof SECTIONS>>((acc, item) => {
		(acc[item.group] ??= []).push(item);
		return acc;
	}, {});

	const setDraft = (key: string, patch: Partial<DraftInput[string]>): void => {
		setDrafts((current) => ({ ...current, [key]: { qty: 1, kind: 'purchase', warehouse: '', supplier: '', rate: 0, ...(current[key] ?? {}), ...patch } }));
	};
	const addDecision = (key: string, item: SupplyOrderItem, index: number): void => {
		const rows = decisions[key] ?? [];
		const used = rows.reduce((a, d) => a + d.qty, 0);
		const remaining = Math.max(item.qty - used, 0);
		const stocks = stockEntries(item);
		const draft = drafts[key] ?? { qty: remaining || 1, kind: stocks.length ? 'transfer' : 'purchase', warehouse: stocks[0]?.[0] ?? '', supplier: '', rate: 0 };
		const rawQty = Math.max(Number(draft.qty) || 1, 1);
		const fromWarehouse = draft.warehouse || stocks[0]?.[0] || '';
		if (remaining <= 0) return;
		let qty = draft.kind === 'purchase' ? rawQty : Math.min(rawQty, remaining);
		if (draft.kind === 'transfer') {
			if (!fromWarehouse) {
				setNotice('Для перемещения нужно выбрать склад-источник.');
				return;
			}
			const stockQty = Number(item.stocks?.[fromWarehouse] ?? 0);
			const alreadyPlanned = rows
				.filter((row) => row.kind === 'transfer' && row.warehouse === fromWarehouse)
				.reduce((sum, row) => sum + row.qty, 0);
			const available = Math.max(stockQty - alreadyPlanned, 0);
			qty = Math.min(qty, available);
			if (qty <= 0) {
				setNotice(`На складе ${fromWarehouse} больше нет доступного остатка для перемещения.`);
				return;
			}
		}
		const next: Decision = { id: `${Date.now()}-${index}`, productId: item.productId, qty, kind: draft.kind, ...(draft.kind === 'transfer' ? { warehouse: fromWarehouse } : { supplier: draft.supplier.trim() || DEFAULT_SUPPLIER, rate: Math.max(Number(draft.rate) || 0, 0) }) };
		setDecisions((current) => ({ ...current, [key]: [...(current[key] ?? []), next] }));
		setDrafts((current) => ({ ...current, [key]: { ...draft, qty: Math.max(remaining - qty, 1) } }));
		setNotice(null);
	};
	const removeDecision = (key: string, id: string): void => {
		setDecisions((current) => ({ ...current, [key]: (current[key] ?? []).filter((row) => row.id !== id) }));
	};
	const openReceivePurchase = (purchase: SupplyPurchaseChild): void => {
		setReceivingPurchase(purchase);
		setReceivingOrderName(detailOrder?.name ?? orders.find((order) => (order.purchases ?? []).some((doc) => doc.name === purchase.name))?.name ?? null);
		setReceiveDraft(Object.fromEntries(purchase.lines.map((line) => [String(line.productId), line.qty])));
		setReceiveStore(DEFAULT_RECEIPT_STORE);
	};
	const closeReceivePurchase = (): void => {
		setReceivingPurchase(null);
		setReceivingOrderName(null);
	};
	const changePurchaseStage = async (purchase: SupplyPurchaseChild, stage: SupplyPurchaseStage): Promise<void> => {
		if (docsBusy) return;
		setDocsBusy(true);
		try {
			if (ctx.__mock) {
				setOrders((current) => current.map((order) => ({
					...order,
					purchases: (order.purchases ?? []).map((doc) => doc.name === purchase.name ? { ...doc, supplyStage: stage, ...(stage === 'ordered' ? { orderedAt: new Date().toISOString().slice(0, 10) } : {}) } : doc),
				})));
			} else {
				await updateSupplyPurchaseStage(purchase.name, stage);
				await refreshOrders(true);
			}
			const view = supplierRequestStatus({ ...purchase, supplyStage: stage });
			setNotice(`${purchase.name}: ${view.label}.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось обновить статус закупки.');
		} finally {
			setDocsBusy(false);
		}
	};
	const submitReceivePurchase = async (): Promise<void> => {
		const purchase = receivingPurchase;
		const order = detailOrder ?? orders.find((row) => row.name === receivingOrderName) ?? (purchase ? orders.find((row) => (row.purchases ?? []).some((doc) => doc.name === purchase.name)) : null);
		if (!order || !purchase || docsBusy) return;
		if (!receiveStore.trim()) {
			setNotice('Для прихода нужен склад оприходования.');
			return;
		}
		const dealId = Number(order.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) {
			setNotice('У заявки нет корректной сделки.');
			return;
		}
		const lines = purchase.lines
			.map((line) => ({ productId: line.productId, qty: Number(receiveDraft[String(line.productId)] ?? 0), rate: Number(line.rate ?? 0) }))
			.filter((line) => Number.isFinite(line.qty) && line.qty > 0);
		if (!lines.length) {
			setNotice('Нет фактически полученных позиций.');
			return;
		}
		setDocsBusy(true);
		try {
			const receipt = await receiveSupplyPurchase(order.name, dealId, purchase.name, receiveStore.trim(), lines);
			setReceivingPurchase(null);
			setReceivingOrderName(null);
			await refreshOrders(true);
			setNotice(`Приход создан: ${receipt}.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось оприходовать закупку.');
		} finally {
			setDocsBusy(false);
		}
	};
	const createTransferFromReceipt = async (order: SupplyOrderRow, purchase: SupplyPurchaseChild, receipt: SupplyPurchaseChild['receipts'][number]): Promise<void> => {
		if (docsBusy) return;
		const dealId = Number(order.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0 || !order.toStore) {
			setNotice('Для перемещения нужен корректный склад заявки и сделка.');
			return;
		}
		const groups = new Map<string, TransferLineDto[]>();
		for (const line of receipt.lines) {
			const fromStore = String(line.warehouse ?? '').trim();
			if (!fromStore || fromStore === order.toStore) continue;
			const rows = groups.get(fromStore) ?? [];
			rows.push({ productId: line.productId, name: line.name, qty: line.qty, ...(line.rate != null ? { rate: line.rate } : {}) });
			groups.set(fromStore, rows);
		}
		if (!groups.size) {
			setNotice('В приходе нет строк со складом, отличным от склада заявки.');
			return;
		}
		setDocsBusy(true);
		try {
			const docs = await createTransfers({
				dealId,
				toStore: order.toStore,
				supplyRequest: order.name,
				groups: [...groups.entries()].map(([fromStore, lines]) => ({ fromStore, lines })),
			});
			await refreshOrders(true);
			setNotice(`Перемещение на точку создано: ${docs.map((doc) => doc.name || `#${doc.id}`).join(', ')}.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : `Не удалось создать перемещение по приходу ${receipt.name} / ${purchase.name}.`);
		} finally {
			setDocsBusy(false);
		}
	};
	const createDocs = async (): Promise<void> => {
		const order = detailOrder;
		if (!order || docsBusy) return;
		const dealId = Number(order.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) {
			setNotice('У заявки нет корректной сделки.');
			return;
		}
		const transferGroups = new Map<string, Array<{ productId: number; name: string; qty: number }>>();
		const purchaseGroups = new Map<string, Array<{ productId: number; itemName: string; qty: number; rate: number }>>();
		for (const [index, item] of order.items.entries()) {
			const key = itemKey(order.name, item.productId, index);
			for (const row of decisions[key] ?? []) {
				if (row.kind === 'transfer') {
					const fromStore = row.warehouse ?? '';
					if (!fromStore) continue;
					const lines = transferGroups.get(fromStore) ?? [];
					lines.push({ productId: item.productId, name: item.itemName || `#${item.productId}`, qty: row.qty });
					transferGroups.set(fromStore, lines);
				} else {
					const supplier = row.supplier || DEFAULT_SUPPLIER;
					const lines = purchaseGroups.get(supplier) ?? [];
					lines.push({ productId: item.productId, itemName: item.itemName || `#${item.productId}`, qty: row.qty, rate: row.rate ?? 0 });
					purchaseGroups.set(supplier, lines);
				}
			}
		}
		if (transferGroups.size && !order.toStore) {
			setNotice('Для перемещений нужен склад назначения. Создай заявку из сделки с выбранным складом.');
			return;
		}
		setDocsBusy(true);
		try {
			const created: string[] = [];
			if (transferGroups.size) {
				const transfers = await createTransfers({
					dealId,
					toStore: order.toStore,
					supplyRequest: order.name,
					groups: [...transferGroups.entries()].map(([fromStore, lines]) => ({ fromStore, lines })),
				});
				created.push(`${transfers.length} перемещ.`);
			}
			for (const [supplier, lines] of purchaseGroups.entries()) {
				const po = await createSupplyPurchaseOrder(order.name, dealId, supplier, lines);
				created.push(`заявка ${supplier}: ${po}`);
			}
			setDecisions((current) => {
				const next = { ...current };
				order.items.forEach((item, index) => { delete next[itemKey(order.name, item.productId, index)]; });
				return next;
			});
			await refreshOrders(true);
			setNotice(created.length ? `Документы созданы: ${created.join(', ')}.` : 'Нет решений для создания документов.');
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось создать документы.');
		} finally {
			setDocsBusy(false);
		}
	};

	if (phase === 'init') return <div className="supply-page supply-state">Загрузка...</div>;
	if (phase === 'denied') return <div className="supply-page supply-state">Раздел «Снаб» в обкатке. Доступ ограничен.</div>;

	return (
		<div className="supply-shell">
			<aside className="supply-rail">
				<div className="supply-brand"><span>С</span><div><b>Снаб</b><small>рабочее место</small></div></div>
				{Object.entries(grouped).map(([group, items]) => (
					<div key={group} className="supply-nav-group">
						<h3>{group}</h3>
						{items.map((item) => <button key={item.key} className={section === item.key ? 'active' : ''} onClick={() => { setSection(item.key); setDetailName(null); }} type="button">{item.title}</button>)}
					</div>
				))}
				<div className="supply-source"><span>Источник данных</span><b>ERPNext / Material Request</b></div>
			</aside>

			{section === 'orders' && detailOrder ? (
				<OrderDetail
					order={detailOrder}
					decisions={decisions}
					drafts={drafts}
					docsBusy={docsBusy}
					onBack={() => setDetailName(null)}
					setDraft={setDraft}
					addDecision={addDecision}
					removeDecision={removeDecision}
					createDocs={() => void createDocs()}
					onReceivePurchase={openReceivePurchase}
					onUpdatePurchaseStage={(purchase, stage) => void changePurchaseStage(purchase, stage)}
					onCreateReceiptTransfer={(order, purchase, receipt) => void createTransferFromReceipt(order, purchase, receipt)}
				/>
			) : (
				<main className="supply-main">
					<header className="supply-top">
						<div>
							<h1>{section === 'orders' ? 'Заявки снабжения' : STUB[section].title}</h1>
							<p>{section === 'orders' ? 'Дефицит из сделок, распределение по источникам, закупка и перемещения' : STUB[section].note}</p>
						</div>
						{section === 'orders' && <button className="supply-primary" type="button" disabled>Создать вручную</button>}
					</header>
					{section === 'orders' ? (
						<>
							<div className="supply-kpis">
								<div><span>Активные заявки</span><b>{orders.filter((o) => !o.closed).length}</b></div>
								<div><span>Позиции</span><b>{orders.reduce((a, o) => a + requestItemsForOrder(o).length, 0)}</b></div>
								<div><span>Закрытые</span><b>{orders.filter((o) => o.closed).length}</b></div>
							</div>
							<div className="supply-content-grid">
								<OrdersList orders={orders} decisions={decisions} loading={loadingOrders} selectedName={selectedPreview?.name ?? null} onPreview={(order) => setPreviewName(order.name)} onOpen={(order) => { setPreviewName(order.name); setDetailName(order.name); }} />
								<PreviewPanel order={selectedPreview} decisions={decisions} />
							</div>
						</>
					) : section === 'purchase' ? (
						<PurchasesSection
							orders={orders}
							loading={loadingOrders}
							docsBusy={docsBusy}
							onOpenOrder={(order) => { setSection('orders'); setPreviewName(order.name); setDetailName(order.name); }}
							onReceivePurchase={openReceivePurchase}
							onUpdatePurchaseStage={(purchase, stage) => void changePurchaseStage(purchase, stage)}
							onCreateReceiptTransfer={(order, purchase, receipt) => void createTransferFromReceipt(order, purchase, receipt)}
						/>
					) : section === 'logistics' ? (
						<LogisticsSection
							orders={orders}
							loading={loadingOrders}
							onOpenOrder={(order) => { setSection('orders'); setPreviewName(order.name); setDetailName(order.name); }}
						/>
					) : section === 'stock' ? (
						<StockDocumentsSection
							orders={orders}
							loading={loadingOrders}
							onOpenOrder={(order) => { setSection('orders'); setPreviewName(order.name); setDetailName(order.name); }}
						/>
					) : (
						<section className="supply-card supply-placeholder">
							<h2>{STUB[section].title}</h2>
							<p>{STUB[section].note}</p>
							<span>Раздел подключим после утверждения основного сценария заявок.</span>
						</section>
					)}
				</main>
			)}
			{receivingPurchase && (
				<div className="supply-modal-overlay">
					<div className="supply-modal">
						<header>
							<div>
								<h2>Оприходование закупки</h2>
								<p>{receivingPurchase.name}</p>
							</div>
							<button type="button" onClick={closeReceivePurchase}>Закрыть</button>
						</header>
						<label className="supply-wide-field">
							<span>Склад оприходования</span>
							<input type="text" value={receiveStore} onChange={(e) => setReceiveStore(e.target.value)} />
						</label>
						<div className="supply-receive-table">
							<div className="supply-receive-head"><span>Позиция</span><span>Заказано</span><span>Пришло</span></div>
							{receivingPurchase.lines.map((line) => (
								<div key={line.productId} className="supply-receive-row">
									<span>{line.name || `#${line.productId}`}</span>
									<b>{line.qty}</b>
									<input type="number" min="0" step="any" value={receiveDraft[String(line.productId)] ?? 0} onChange={(e) => setReceiveDraft((current) => ({ ...current, [String(line.productId)]: Number(e.target.value) }))} />
								</div>
							))}
						</div>
						<footer>
							<button type="button" onClick={closeReceivePurchase}>Отмена</button>
							<button className="supply-primary" type="button" disabled={docsBusy} onClick={() => void submitReceivePurchase()}>{docsBusy ? 'Проводим...' : 'Оприходовать'}</button>
						</footer>
					</div>
				</div>
			)}
			<datalist id="supply-suppliers">{suppliers.map((name) => <option key={name} value={name} />)}</datalist>
			{notice && <div className="supply-toast" onClick={() => setNotice(null)}>{notice}</div>}
		</div>
	);
}
