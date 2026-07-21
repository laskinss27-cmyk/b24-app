import { useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import { ProductBase } from './ProductBase.js';
import { LedgerTab, StockLedger, StockMovementsTab, StockTransfersTab, TransferRequestsTab, type StockMovementKind } from './StockLedger.js';
import {
	cancelTransfer,
	createIssueDoc,
	createManualTransfer,
	createReceiptDoc,
	createStandaloneSupplyPurchase,
	createSupplySupplier,
	createSupplyDocuments,
	createSupplyPurchaseTransfer,
	deleteSupplyPurchaseOrder,
	deleteTransfer,
	fetchCurrentUserId,
	fetchStockFormData,
	openDeal,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	receiveSupplyPurchase,
	receiveTransfer,
	collectTransfer,
	postTransfer,
	resolveTransferShortage,
	shipTransfer,
	updateTransferDestination,
	updateTransferLines,
	updateSupplyPurchaseOrder,
	updateSupplyPurchaseStage,
	updateSupplyOrderNote,
	type SupplyDecisionAction,
	type SupplyDecisionLine,
	type SupplyOrderItem,
	type SupplyOrderRow,
	type SupplyPurchaseChild,
	type SupplyPurchaseStage,
	type SupplyTransferChild,
	withTimeout,
} from './b24.js';

const MOCK_ORDERS: SupplyOrderRow[] = [
	{
		name: 'MAT-MR-2026-0001',
		requestKey: 'MAT-MR-2026-0001@demo',
		dealId: '36766',
		dealTitle: '37204_тест ERP',
		date: '2026-07-10',
		deadline: '2026-07-17',
		status: 'Pending',
		closed: false,
		toStore: 'Максидом Дунайский 64',
		note: 'Для монтажа по сделке, привезти одной партией.',
		items: [
			{ productId: 16758, itemName: 'IP-камера 4 Мп CTV-IPB2028', qty: 6, note: 'нужно новое, в упаковке', stocks: { Парнас: 2, Офис: 1 } },
			{ productId: 202, itemName: 'Контроллер СКУД ZKTeco', qty: 4, note: '', stocks: {} },
		],
		purchases: [],
		transfers: [{
			id: 9001,
			name: 'Перемещение #36766: Максидом Тельмана 31 → Максидом Дунайский 64',
			status: 'accepted',
			fromStore: 'Максидом Тельмана 31',
			toStore: 'Максидом Дунайский 64',
			lines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 2 }],
			collectedLines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 2 }],
			shippedLines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 2 }],
			acceptedLines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 1 }],
			receivedLines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 1 }],
			shortageLines: [],
			history: [
				{ at: '2026-07-14T07:10:00.000Z', status: 'draft', byId: '1858', byName: 'Сергей Ласкин', action: 'created' },
				{ at: '2026-07-14T07:30:00.000Z', status: 'collected', byId: '101', byName: 'Менеджер точки', action: 'collected', note: 'собрано полностью' },
				{ at: '2026-07-14T08:00:00.000Z', status: 'in_transit', byId: '101', byName: 'Менеджер точки', action: 'shipped' },
				{ at: '2026-07-14T09:15:00.000Z', status: 'accepted', byId: '102', byName: 'Менеджер приемки', action: 'accepted', note: 'принято с расхождениями', changes: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', field: 'accepted', from: 0, to: 1 }] },
			],
		}],
	},
	{
		name: 'MAT-MR-2026-0002',
		requestKey: 'MAT-MR-2026-0002@demo',
		dealId: '36801',
		dealTitle: 'СКУД офис',
		date: '2026-07-11',
		deadline: '2026-07-18',
		status: 'Pending',
		closed: false,
		toStore: 'Измайловский 18Д',
		note: '',
		items: [{ productId: 301, itemName: 'Домофон Tantos Prime SD', qty: 1, note: '', stocks: { Офис: 1 } }],
		purchases: [],
		transfers: [{
			id: 9010,
			name: 'Перемещение #36801: Максидом Московский 131 → Измайловский 18Д',
			status: 'posted',
			fromStore: 'Максидом Московский 131',
			toStore: 'Измайловский 18Д',
			shipEntry: 'MAT-STE-DEMO-001',
			receiveEntry: 'MAT-STE-DEMO-002',
			correctionIds: [9011],
			lines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 2 }],
			collectedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 3 }],
			shippedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 3 }],
			acceptedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 2 }],
			receivedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 2 }],
			shortageLines: [],
			history: [],
		}, {
			id: 9011,
			name: 'Корректировка #9010: Транзит → Максидом Московский 131',
			status: 'posted',
			fromStore: 'Транзит',
			toStore: 'Максидом Московский 131',
			receiveEntry: 'MAT-STE-DEMO-003',
			correctionOf: 9010,
			correctionKind: 'shortage_return',
			lines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			collectedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			shippedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			acceptedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			receivedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			shortageLines: [],
			history: [],
		}],
	},
];

type Phase = 'init' | 'denied' | 'manager-link' | 'ready';
type ViewKey = 'orders' | 'incoming' | 'purchase' | 'logistics' | 'stocks' | StockMovementKind | 'ledger';
type SortKey = 'dateDesc' | 'dateAsc' | 'store' | 'deal';

interface DecisionState {
	id: string;
	action: SupplyDecisionAction | '';
	qty: number;
	fromStore: string;
	supplier: string;
}

type DecisionMap = Record<string, DecisionState[]>;

const DEFAULT_SUPPLIERS = ['Поставщик не выбран', 'ТД Юнона', 'Сатро-Паладин', 'Амиком'];
const supplierNorm = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const money = (value: number): string => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
const requestItemsForOrder = (order: SupplyOrderRow): SupplyOrderItem[] => order.items ?? [];
const rowKey = (orderName: string, productId: number, index: number): string => `${orderName}:${productId}:${index}`;
let allocationSequence = 0;
const makeDecision = (key: string, qty: number): DecisionState => ({
	id: `${key}:allocation-${allocationSequence++}`,
	action: '',
	qty: Math.max(1, qty),
	fromStore: '',
	supplier: '',
});
const decisionsForRow = (decisions: DecisionMap, key: string, qty: number): DecisionState[] => decisions[key] ?? [{ ...makeDecision(key, qty), id: `${key}:initial` }];
const decisionReady = (decision: DecisionState): boolean => Boolean(decision.action && (decision.action === 'transfer' ? decision.fromStore : decision.supplier.trim()));

function SupplierField({ id, label, value, suppliers, placeholder = 'поставщик', onChange, onCreate }: {
	id: string;
	label?: string;
	value: string;
	suppliers: string[];
	placeholder?: string;
	onChange: (value: string) => void;
	onCreate: (name: string) => Promise<string>;
}): JSX.Element {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const clean = value.trim();
	const exists = suppliers.some((supplier) => supplierNorm(supplier) === supplierNorm(clean));
	const canCreate = clean.length >= 2 && clean !== 'Поставщик не выбран' && !exists;
	const create = async (): Promise<void> => {
		if (!canCreate || busy) return;
		setBusy(true);
		setError('');
		try { onChange(await onCreate(clean)); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	};
	return (
		<div className="supply-supplier-field">
			{label && <label htmlFor={id}>{label}</label>}
			<input id={id} list={`${id}-list`} value={value} onChange={(event) => { setError(''); onChange(event.target.value); }} placeholder={placeholder} autoComplete="off" />
			<datalist id={`${id}-list`}>{suppliers.map((supplier) => <option key={supplier} value={supplier} />)}</datalist>
			{canCreate && <button className="supply-create-supplier" type="button" disabled={busy} onClick={() => void create()}>{busy ? 'Создаю...' : `+ Создать «${clean}»`}</button>}
			{error && <small className="supply-create-supplier-error">{error}</small>}
		</div>
	);
}

function decisionLinesForOrder(order: SupplyOrderRow, decisions: DecisionMap): SupplyDecisionLine[] {
	return requestItemsForOrder(order).flatMap((item, index) => {
		const key = rowKey(order.name, item.productId, index);
		return decisionsForRow(decisions, key, item.qty)
			.filter(decisionReady)
			.map((decision) => ({
				productId: item.productId,
				itemName: item.itemName || `#${item.productId}`,
				qty: Math.max(1, Number(decision.qty || 1)),
				action: decision.action as SupplyDecisionAction,
				...(decision.fromStore ? { fromStore: decision.fromStore } : {}),
				...(decision.supplier.trim() ? { supplier: decision.supplier.trim() } : {}),
			}));
	});
}

function decisionGroups(lines: SupplyDecisionLine[], action: SupplyDecisionAction): Array<{ key: string; lines: SupplyDecisionLine[] }> {
	const groups = new Map<string, SupplyDecisionLine[]>();
	for (const line of lines.filter((item) => item.action === action)) {
		const key = action === 'transfer' ? String(line.fromStore ?? '') : String(line.supplier ?? '');
		groups.set(key, [...(groups.get(key) ?? []), line]);
	}
	return [...groups.entries()].map(([key, groupedLines]) => ({ key, lines: groupedLines }));
}

const stockEntries = (item: { stocks: Record<string, number> }): Array<[string, number]> =>
	Object.entries(item.stocks ?? {}).filter(([, qty]) => Number(qty) > 0).sort((a, b) => b[1] - a[1]);

const compactStock = (item: { stocks: Record<string, number> }): string => {
	const entries = stockEntries(item);
	if (!entries.length) return 'нет на складах';
	return entries.map(([name, qty]) => `${name}: ${qty}`).join(' · ');
};

const purchaseStatus = (purchase: SupplyPurchaseChild): { label: string; tone: string } => {
	const ordered = purchase.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0);
	const received = purchase.receipts.reduce((sum, receipt) => sum + receipt.lines.reduce((a, line) => a + Number(line.qty || 0), 0), 0);
	const stage = String(purchase.supplyStage ?? purchase.status ?? '').toLowerCase();
	if (ordered > 0 && received >= ordered) return { label: 'Получено', tone: 'ok' };
	if (received > 0) return { label: 'Частично получено', tone: 'warn' };
	if (stage.includes('order') || stage.includes('submit') || stage.includes('receive')) return { label: 'Заказано', tone: 'info' };
	if (stage.includes('approval')) return { label: 'На согласовании', tone: 'violet' };
	return { label: 'Черновик', tone: 'muted' };
};

function purchaseTransferAvailable(order: SupplyOrderRow, purchase: SupplyPurchaseChild): Map<number, number> {
	const requested = new Map<number, number>();
	for (const line of order.originalItems ?? order.items) requested.set(line.productId, (requested.get(line.productId) ?? 0) + Number(line.qty || 0));
	const covered = new Map<number, number>();
	const forwarded = new Map<number, number>();
	for (const transfer of order.transfers ?? []) {
		if (transfer.status === 'canceled' || transfer.correctionOf) continue;
		for (const line of transfer.lines) {
			covered.set(line.productId, (covered.get(line.productId) ?? 0) + Number(line.qty || 0));
			if (transfer.purchaseOrder === purchase.name) forwarded.set(line.productId, (forwarded.get(line.productId) ?? 0) + Number(line.qty || 0));
		}
	}
	const received = new Map<number, number>();
	for (const receipt of purchase.receipts) for (const line of receipt.lines) received.set(line.productId, (received.get(line.productId) ?? 0) + Number(line.qty || 0));
	return new Map(purchase.lines.map((line) => {
		const alreadyForwarded = forwarded.get(line.productId) ?? 0;
		const onReceiptStore = Math.max((received.get(line.productId) ?? 0) - alreadyForwarded, 0);
		const neededAtPoint = Math.max((requested.get(line.productId) ?? 0) - (covered.get(line.productId) ?? 0), 0);
		const allocatedRemaining = Math.max(Math.min(Number(line.qty || 0), Number(line.requestQty ?? line.qty)) - alreadyForwarded, 0);
		return [line.productId, Math.min(onReceiptStore, neededAtPoint, allocatedRemaining)];
	}));
}

const transferStatus = (transfer: SupplyTransferChild): { label: string; tone: string } => {
	if (transfer.status === 'draft') return { label: 'Черновик', tone: 'muted' };
	if (transfer.status === 'collected') return { label: 'Собрано', tone: 'info' };
	if (transfer.status === 'received') return { label: 'Получено', tone: 'ok' };
	if (transfer.status === 'accepted') return { label: 'На проверке', tone: 'info' };
	if (transfer.status === 'posted') return { label: transfer.correctionOf ? 'Завершено' : 'Принято', tone: 'ok' };
	if (transfer.status === 'shortage') return { label: 'Недовоз', tone: 'warn' };
	if (transfer.status === 'in_transit') return { label: 'В пути', tone: 'info' };
	if (transfer.status === 'canceled') return { label: 'Отменено', tone: 'muted' };
	return { label: 'Создано', tone: 'muted' };
};

const transferHasDiscrepancy = (transfer: SupplyTransferChild): boolean => {
	if (transfer.status === 'shortage') return true;
	if (transfer.status === 'collected') {
		const collected = new Map((transfer.collectedLines ?? []).map((line) => [line.productId, line.qty]));
		return transfer.lines.some((line) => Math.abs(line.qty - (collected.get(line.productId) ?? 0)) > 0.000001);
	}
	if (transfer.status !== 'accepted') return false;
	const shipped = new Map((transfer.shippedLines ?? transfer.lines).map((line) => [line.productId, line.qty]));
	const accepted = new Map((transfer.acceptedLines ?? transfer.receivedLines ?? []).map((line) => [line.productId, line.qty]));
	return [...new Set([...shipped.keys(), ...accepted.keys()])].some((id) => Math.abs((shipped.get(id) ?? 0) - (accepted.get(id) ?? 0)) > 0.000001);
};

const TRANSFER_HISTORY_LABELS: Record<string, string> = {
	created: 'Создано',
	lines_changed: 'Количество изменено',
	destination_changed: 'Склад назначения изменен',
	collected: 'Собрано',
	shipped: 'Отправлено',
	accepted: 'Принято',
	posted: 'Проведено',
	canceled: 'Отменено',
	notification_sent: 'Сообщение отправлено',
	notification_failed: 'Сообщение не отправлено',
	legacy: 'Изменено',
};

const transferHistoryLabel = (event: { note?: string; action?: string; status: string }): string =>
	event.note || (event.action ? TRANSFER_HISTORY_LABELS[event.action] : '') || event.status;

const transferDocumentLabel = (transfer: SupplyTransferChild): string => {
	const entries = [transfer.shipEntry, transfer.receiveEntry || transfer.shortageReturnEntry].filter((name): name is string => Boolean(name));
	return entries.length ? entries.join(' → ') : `#${transfer.id}`;
};

const lineTitle = (line: { name?: string; itemName?: string; productId: number; qty: number }): string =>
	`${line.name || line.itemName || `#${line.productId}`} ×${line.qty}`;
const purchaseQuantities = (purchase: SupplyPurchaseChild): { ordered: number; received: number } => ({
	ordered: purchase.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0),
	received: purchase.receipts.reduce((sum, receipt) => sum + receipt.lines.reduce((subtotal, line) => subtotal + Number(line.qty || 0), 0), 0),
});
const purchaseIsCancelled = (purchase: SupplyPurchaseChild): boolean => String(purchase.supplyStage ?? '').toLowerCase() === 'cancelled';
const purchaseIsShortage = (purchase: SupplyPurchaseChild): boolean => {
	const { ordered, received } = purchaseQuantities(purchase);
	return !purchaseIsCancelled(purchase) && received > 0 && received < ordered;
};
const purchaseIsWaiting = (purchase: SupplyPurchaseChild): boolean => {
	const { ordered, received } = purchaseQuantities(purchase);
	return !purchaseIsCancelled(purchase) && ordered > 0 && received < ordered;
};
const purchaseAmount = (purchase: SupplyPurchaseChild): number =>
	purchase.lines.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.rate || 0), 0);

const searchMatches = (query: string, values: Array<string | number | undefined>): boolean => {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const haystack = values.map((value) => String(value ?? '')).join(' ').toLowerCase();
	return words.every((word) => haystack.includes(word));
};
const orderSearchValues = (order: SupplyOrderRow): Array<string | number | undefined> => [
	order.name,
	order.dealId,
	order.dealTitle,
	order.toStore,
	order.deadline,
	order.note,
	...requestItemsForOrder(order).flatMap((item) => [item.productId, item.itemName, ...Object.keys(item.stocks ?? {})]),
	...(order.originalItems ?? []).flatMap((item) => [item.productId, item.itemName, ...Object.keys(item.stocks ?? {})]),
	...(order.purchases ?? []).flatMap((purchase) => [purchase.name, purchase.supplier, ...purchase.lines.flatMap((line) => [line.productId, line.name])]),
	...(order.transfers ?? []).flatMap((transfer) => [transfer.id, transfer.name, transfer.fromStore, transfer.toStore, ...transfer.lines.flatMap((line) => [line.productId, line.name])]),
];
const purchaseSearchValues = (order: SupplyOrderRow, purchase: SupplyPurchaseChild): Array<string | number | undefined> => [
	order.name, order.dealId, order.dealTitle, order.toStore, purchase.name, purchase.supplier,
	...purchase.lines.flatMap((line) => [line.productId, line.name, line.warehouse]),
	...purchase.receipts.flatMap((receipt) => [receipt.name, ...receipt.lines.flatMap((line) => [line.productId, line.name, line.warehouse])]),
];
const transferSearchValues = (order: SupplyOrderRow, transfer: SupplyTransferChild): Array<string | number | undefined> => [
	order.name, order.dealId, order.dealTitle, order.toStore, transfer.id, transfer.name, transfer.purchaseOrder, transfer.fromStore, transfer.toStore,
	...transfer.lines.flatMap((line) => [line.productId, line.name, line.warehouse]),
];
const documentAmount = (lines: Array<{ qty: number }>): string => {
	const qty = lines.reduce((sum, line) => sum + Number(line.qty || 0), 0);
	return `${lines.length} поз. · ${qty} шт`;
};

function Pill({ tone, children }: { tone: string; children: string }): JSX.Element {
	return <span className={`supply-proto-pill ${tone}`}>{children}</span>;
}

function Metrics({ orders, view }: { orders: SupplyOrderRow[]; view: ViewKey }): JSX.Element {
	const requests = orders.filter((order) => !order.standalone);
	const purchases = orders.flatMap((order) => order.purchases ?? []);
	const transfers = orders.flatMap((order) => order.transfers ?? []);
	const entries = view === 'orders'
		? [
			{ label: 'Необработанные заявки', value: requests.filter((order) => requestItemsForOrder(order).length > 0).length },
			{ label: 'Необработанные позиции', value: requests.reduce((sum, order) => sum + requestItemsForOrder(order).length, 0) },
			{ label: 'Всего обработано', value: requests.filter((order) => requestItemsForOrder(order).length === 0).length },
		]
		: view === 'purchase'
			? [
				{ label: 'Заявки в ожидании', value: purchases.filter(purchaseIsWaiting).length },
				{ label: 'Сумма заявок', value: `${money(purchases.filter((purchase) => !purchaseIsCancelled(purchase)).reduce((sum, purchase) => sum + purchaseAmount(purchase), 0))} ₽` },
				{ label: 'Заявки с недовозом', value: purchases.filter(purchaseIsShortage).length },
			]
			: [
				{ label: 'Перемещения в пути', value: transfers.filter((transfer) => transfer.status === 'in_transit').length },
				{ label: 'Перемещения с расхождениями', value: transfers.filter(transferHasDiscrepancy).length },
			];
	return (
		<div className={`supply-proto-metrics columns-${entries.length}`}>
			{entries.map((entry) => <div key={entry.label}><span>{entry.label}</span><b>{entry.value}</b></div>)}
		</div>
	);
}

function SupplySearch({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
	return (
		<label className="supply-proto-search">
			<span>Поиск</span>
			<input type="search" value={value} placeholder="Сделка, склад, товар или поставщик" onChange={(event) => onChange(event.target.value)} />
		</label>
	);
}

function documentsSummary(order: SupplyOrderRow): JSX.Element {
	const docs = (order.transfers?.length ?? 0) + (order.purchases?.length ?? 0);
	if (!docs) return <Pill tone="muted">документов нет</Pill>;
	return <Pill tone="info">{`${docs} документ(а)`}</Pill>;
}

type OpenSupplyDocument =
	| { kind: 'purchase'; order: SupplyOrderRow; purchase: SupplyPurchaseChild }
	| { kind: 'transfer'; order: SupplyOrderRow; transfer: SupplyTransferChild };

type NumericDraft = number | '';
type PurchaseDraftRow = { key: string; productId: number; itemName: string; qty: NumericDraft; rate: NumericDraft };
const numericDraft = (value: string): NumericDraft => value === '' ? '' : Number(value);

const PURCHASE_STAGE_OPTIONS: Array<{ value: SupplyPurchaseStage; label: string }> = [
	{ value: 'draft', label: 'Черновик' },
	{ value: 'approval', label: 'На согласовании' },
	{ value: 'approved', label: 'Согласовано' },
	{ value: 'ordered', label: 'Заказано' },
	{ value: 'cancelled', label: 'Отменено' },
];

interface SupplyPrintLine { productId: number; itemName: string; qty: number; rate: number }
const printMoney = (value: number): string => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const printDate = (value?: string): string => {
	const date = value ? new Date(value) : new Date();
	return Number.isNaN(date.getTime()) ? (value || '—') : date.toLocaleDateString('ru-RU');
};

function SupplyPurchasePrint({ order, name, supplier, expectedAt, lines }: {
	order: SupplyOrderRow;
	name: string;
	supplier: string;
	expectedAt: string;
	lines: SupplyPrintLine[];
}): JSX.Element {
	const total = lines.reduce((sum, line) => sum + line.qty * line.rate, 0);
	return (
		<section className="supply-print supply-print-purchase">
			<header className="supply-print-header">
				<div><span>Умный дом</span><h1>Заявка поставщику</h1></div>
				<div className="supply-print-number"><b>{name}</b><span>от {printDate()}</span></div>
			</header>
			<dl className="supply-print-facts">
				<div><dt>Поставщик</dt><dd>{supplier || '—'}</dd></div>
				<div><dt>Заказчик</dt><dd>Умный дом</dd></div>
				<div><dt>Ожидаемая дата</dt><dd>{expectedAt ? printDate(expectedAt) : '—'}</dd></div>
				<div><dt>Основание</dt><dd>{order.standalone ? 'Самостоятельная закупка' : order.name}</dd></div>
			</dl>
			<table className="supply-print-table">
				<thead><tr><th>№</th><th>Код</th><th>Наименование</th><th>Кол-во</th><th>Цена, ₽</th><th>Сумма, ₽</th></tr></thead>
				<tbody>{lines.map((line, index) => <tr key={`${line.productId}-${index}`}><td>{index + 1}</td><td>{line.productId}</td><td>{line.itemName}</td><td className="num">{line.qty}</td><td className="num">{line.rate > 0 ? printMoney(line.rate) : '—'}</td><td className="num">{line.rate > 0 ? printMoney(line.qty * line.rate) : '—'}</td></tr>)}</tbody>
				<tfoot><tr><td colSpan={5}>Итого</td><td className="num">{total > 0 ? `${printMoney(total)} ₽` : '—'}</td></tr></tfoot>
			</table>
			<p className="supply-print-note">Просим подтвердить наличие, срок поставки и итоговую стоимость.</p>
			<div className="supply-print-signatures"><span>Поставщик ____________________</span><span>Заказчик ____________________</span></div>
		</section>
	);
}

function SupplyApprovalPrint({ order }: { order: SupplyOrderRow }): JSX.Element {
	const purchases = (order.purchases ?? []).filter((purchase) => !purchaseIsCancelled(purchase));
	const suppliersByProduct = new Map<number, Set<string>>();
	for (const purchase of purchases) for (const line of purchase.lines) {
		const suppliers = suppliersByProduct.get(line.productId) ?? new Set<string>();
		suppliers.add(purchase.supplier || 'Поставщик не выбран');
		suppliersByProduct.set(line.productId, suppliers);
	}
	const grandTotal = purchases.reduce((sum, purchase) => sum + purchaseAmount(purchase), 0);
	return (
		<section className="supply-print supply-print-approval">
			<header className="supply-print-header">
				<div><span>Умный дом · снабжение</span><h1>Сводная заявка на согласование</h1></div>
				<div className="supply-print-number"><b>{order.name}</b><span>от {printDate(order.date)}</span></div>
			</header>
			<dl className="supply-print-facts">
				<div><dt>Сделка</dt><dd>#{order.dealId} · {order.dealTitle || '—'}</dd></div>
				<div><dt>Точка</dt><dd>{order.toStore || '—'}</dd></div>
				<div><dt>Нужно до</dt><dd>{order.deadline ? printDate(order.deadline) : '—'}</dd></div>
				<div><dt>Поставщиков</dt><dd>{purchases.length}</dd></div>
				<div><dt>Общая сумма</dt><dd>{grandTotal > 0 ? `${printMoney(grandTotal)} ₽` : '—'}</dd></div>
			</dl>
			{order.note && <p className="supply-print-note"><b>Комментарий:</b> {order.note}</p>}
			<table className="supply-print-table supply-print-approval-table">
				<thead><tr><th>Поставщик / заявка</th><th>Код</th><th>Наименование</th><th>Кол-во</th><th>Цена, ₽</th><th>Сумма, ₽</th></tr></thead>
				{purchases.map((purchase) => {
					const subtotal = purchaseAmount(purchase);
					return <tbody key={purchase.name}>
						<tr className="supplier-row"><td colSpan={6}><b>{purchase.supplier || 'Поставщик не выбран'}</b><span>{purchase.name} · {purchaseStatus(purchase).label}</span></td></tr>
						{purchase.lines.map((line, index) => {
							const alternatives = suppliersByProduct.get(line.productId)?.size ?? 0;
							const rate = Number(line.rate || 0);
							return <tr key={`${purchase.name}-${line.productId}-${index}`}><td></td><td>{line.productId}</td><td>{line.name || `#${line.productId}`}{alternatives > 1 && <small>Есть предложения от {alternatives} поставщиков</small>}</td><td className="num">{line.qty}</td><td className="num">{rate > 0 ? printMoney(rate) : '—'}</td><td className="num">{rate > 0 ? printMoney(Number(line.qty || 0) * rate) : '—'}</td></tr>;
						})}
						<tr className="subtotal-row"><td colSpan={5}>Итого по поставщику</td><td className="num">{subtotal > 0 ? printMoney(subtotal) : '—'}</td></tr>
					</tbody>;
				})}
				<tfoot><tr><td colSpan={5}>Итого к согласованию</td><td className="num">{grandTotal > 0 ? `${printMoney(grandTotal)} ₽` : '—'}</td></tr></tfoot>
			</table>
			<div className="supply-print-signatures"><span>Подготовил ____________________</span><span>Согласовал ____________________</span></div>
		</section>
	);
}

function DocumentDetail({ document, suppliers, busy, canDelete, onClose, onDelete, onCreateSupplier, onSavePurchase, onReceivePurchase, onCreatePurchaseTransfer, onChangeTransferDestination, onUpdateTransfer, onCollectTransfer, onShipTransfer, onReceiveTransfer, onPostTransfer, onCancelTransfer, onResolveShortage }: {
	document: OpenSupplyDocument;
	suppliers: string[];
	busy: boolean;
	canDelete: boolean;
	onClose: () => void;
	onDelete: () => void;
	onCreateSupplier: (name: string) => Promise<string>;
	onSavePurchase: (supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>, stage: SupplyPurchaseStage, expectedAt: string) => void;
	onReceivePurchase: (lines: Array<{ productId: number; qty: number; rate: number }>) => void;
	onCreatePurchaseTransfer: (lines: Array<{ productId: number; qty: number }>) => void;
	onChangeTransferDestination: (toStore: string) => Promise<SupplyTransferChild>;
	onUpdateTransfer: (lines: Array<{ productId: number; qty: number }>) => void;
	onCollectTransfer: (lines: Array<{ productId: number; qty: number }>) => void;
	onShipTransfer: () => void;
	onReceiveTransfer: (lines: Array<{ productId: number; qty: number }>) => void;
	onPostTransfer: () => void;
	onCancelTransfer: () => void;
	onResolveShortage: () => void;
}): JSX.Element {
	const purchase = document.kind === 'purchase' ? document.purchase : null;
	const initialTransfer = document.kind === 'transfer' ? document.transfer : null;
	const [supplier, setSupplier] = useState(purchase?.supplier ?? '');
	const [purchaseStage, setPurchaseStage] = useState<SupplyPurchaseStage>((purchase?.supplyStage as SupplyPurchaseStage | undefined) ?? 'draft');
	const [expectedAt, setExpectedAt] = useState(purchase?.expectedAt ?? '');
	const [purchaseLines, setPurchaseLines] = useState<PurchaseDraftRow[]>(() => (purchase?.lines ?? []).map((line, index) => ({
		key: `${line.productId}:${index}`,
		productId: line.productId,
		itemName: line.name || `#${line.productId}`,
		qty: Number(line.qty || 0),
		rate: Number(line.rate || 0) > 0.01 ? Number(line.rate) : 0,
	})));
	const [receiveLines, setReceiveLines] = useState<Record<string, NumericDraft>>(() => Object.fromEntries((initialTransfer?.lines ?? []).map((line) => [String(line.productId), line.qty])));
	const [plannedLines, setPlannedLines] = useState<Record<string, NumericDraft>>(() => Object.fromEntries((initialTransfer?.lines ?? []).map((line) => [String(line.productId), line.qty])));
	const [collectLines, setCollectLines] = useState<Record<string, NumericDraft>>(() => {
		const collected = new Map((initialTransfer?.collectedLines ?? []).map((line) => [line.productId, line.qty]));
		return Object.fromEntries((initialTransfer?.lines ?? []).map((line) => [String(line.productId), collected.get(line.productId) ?? line.qty]));
	});
	const [historyOpen, setHistoryOpen] = useState(false);
	const [destinationStores, setDestinationStores] = useState<string[]>([]);
	const [toStore, setToStore] = useState(initialTransfer?.toStore ?? '');
	const [savingDestination, setSavingDestination] = useState(false);
	const [destinationError, setDestinationError] = useState<string | null>(null);
	const [purchaseReceiveLines, setPurchaseReceiveLines] = useState<Record<string, NumericDraft>>(() => {
		if (!purchase) return {};
		const received = new Map<number, number>();
		for (const receipt of purchase.receipts) for (const line of receipt.lines) received.set(line.productId, (received.get(line.productId) ?? 0) + Number(line.qty || 0));
		return Object.fromEntries(purchase.lines.map((line) => [String(line.productId), Math.max(Number(line.qty || 0) - (received.get(line.productId) ?? 0), 0)]));
	});
	const [purchaseTransferLines, setPurchaseTransferLines] = useState<Record<string, NumericDraft>>(() => {
		if (!purchase || document.kind !== 'purchase') return {};
		return Object.fromEntries(purchaseTransferAvailable(document.order, purchase));
	});
	useEffect(() => {
		if (!purchase) return;
		const received = new Map<number, number>();
		for (const receipt of purchase.receipts) for (const line of receipt.lines) received.set(line.productId, (received.get(line.productId) ?? 0) + Number(line.qty || 0));
		setPurchaseReceiveLines(Object.fromEntries(purchase.lines.map((line) => [String(line.productId), Math.max(Number(line.qty || 0) - (received.get(line.productId) ?? 0), 0)])));
		if (document.kind === 'purchase') setPurchaseTransferLines(Object.fromEntries(purchaseTransferAvailable(document.order, purchase)));
	}, [document, purchase]);
	useEffect(() => {
		if (!initialTransfer || !['draft', 'collected', 'requested', 'in_transit'].includes(initialTransfer.status)) return;
		void fetchStockFormData().then((data) => setDestinationStores(data.stores)).catch((error) => setDestinationError(error instanceof Error ? error.message : String(error)));
	}, [initialTransfer]);
	useEffect(() => setToStore(initialTransfer?.toStore ?? ''), [initialTransfer?.toStore]);
	useEffect(() => {
		if (!initialTransfer) return;
		setPlannedLines(Object.fromEntries(initialTransfer.lines.map((line) => [String(line.productId), line.qty])));
		const collected = new Map((initialTransfer.collectedLines ?? []).map((line) => [line.productId, line.qty]));
		setCollectLines(Object.fromEntries(initialTransfer.lines.map((line) => [String(line.productId), collected.get(line.productId) ?? line.qty])));
		const accepted = new Map((initialTransfer.acceptedLines ?? initialTransfer.receivedLines ?? []).map((line) => [line.productId, line.qty]));
		setReceiveLines(Object.fromEntries(initialTransfer.lines.map((line) => [String(line.productId), accepted.get(line.productId) ?? line.qty])));
	}, [initialTransfer]);
	const saveDestination = async (): Promise<void> => {
		if (!initialTransfer || !toStore || toStore === initialTransfer.toStore || savingDestination) return;
		setSavingDestination(true);
		setDestinationError(null);
		try {
			const updated = await onChangeTransferDestination(toStore);
			setToStore(updated.toStore);
		} catch (error) {
			setDestinationError(error instanceof Error ? error.message : String(error));
		} finally {
			setSavingDestination(false);
		}
	};

	if (document.kind === 'purchase') {
		const { order, purchase: currentPurchase } = document;
		const status = purchaseStatus(currentPurchase);
		const total = purchaseLines.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.rate || 0), 0);
		const receivedByProduct = new Map<number, number>();
		for (const receipt of currentPurchase.receipts) for (const line of receipt.lines) receivedByProduct.set(line.productId, (receivedByProduct.get(line.productId) ?? 0) + Number(line.qty || 0));
		const canReceivePurchase = currentPurchase.supplyStage === 'ordered' && purchaseLines.some((line) => Math.max(Number(line.qty || 0) - (receivedByProduct.get(line.productId) ?? 0), 0) > 0);
		const transferAvailable = purchaseTransferAvailable(order, currentPurchase);
		const canCreatePurchaseTransfer = [...transferAvailable.values()].some((qty) => qty > 0);
		const receivePurchasePayload = purchaseLines.map((line) => ({
			productId: line.productId,
			qty: Math.max(0, Math.min(Number(purchaseReceiveLines[String(line.productId)] || 0), Math.max(Number(line.qty || 0) - (receivedByProduct.get(line.productId) ?? 0), 0))),
			rate: Number(line.rate || 0),
		})).filter((line) => line.qty > 0);
		const purchaseTransferPayload = purchaseLines.map((line) => ({
			productId: line.productId,
			qty: Math.max(0, Math.min(Number(purchaseTransferLines[String(line.productId)] || 0), transferAvailable.get(line.productId) ?? 0)),
		})).filter((line) => line.qty > 0);
		return (
			<div className="supply-proto-overlay">
				<section className="supply-proto-modal supply-document-modal" role="dialog" aria-modal="true" aria-label={`Заявка поставщику ${currentPurchase.name}`}>
					<header>
						<div><span className="supply-document-eyebrow">Заявка поставщику</span><h2>{currentPurchase.name}</h2><p>{order.standalone ? 'Самостоятельная закупка' : `${order.name} · сделка #${order.dealId}`}</p></div>
						<div className="supply-document-modal-head"><span>{status.label}</span><button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button></div>
					</header>
					<dl className="supply-document-facts">
						<div><dt>Поставщик</dt><dd><SupplierField id="supply-document-supplier" value={supplier} suppliers={suppliers} onChange={setSupplier} onCreate={onCreateSupplier} /></dd></div>
						<div><dt>Склад заявки</dt><dd>{order.toStore || 'Не указан'}</dd></div>
						<div><dt>Ожидаем</dt><dd><input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} /></dd></div>
						<div><dt>Сумма</dt><dd>{total > 0.01 ? `${money(total)} ₽` : '—'}</dd></div>
					</dl>
					<div className="supply-document-lines">
						<table><thead><tr><th>Позиция</th><th>Количество</th><th>Цена</th><th>Сумма</th>{canReceivePurchase && <th>К приходу</th>}{canCreatePurchaseTransfer && <th>К перемещению</th>}<th aria-label="Удалить" /></tr></thead><tbody>
							{purchaseLines.map((line) => {
								const transferMax = transferAvailable.get(line.productId) ?? 0;
								return <tr key={line.key}>
									<td><b>{line.itemName}</b><small>#{line.productId}</small></td>
									<td><input type="number" min="0" step="any" value={line.qty} onChange={(e) => setPurchaseLines((current) => current.map((row) => row.key === line.key ? { ...row, qty: numericDraft(e.target.value) } : row))} /></td>
									<td><input type="number" min="0" step="any" value={line.rate} onChange={(e) => setPurchaseLines((current) => current.map((row) => row.key === line.key ? { ...row, rate: numericDraft(e.target.value) } : row))} /></td>
									<td>{Number(line.rate || 0) > 0 ? `${money(Number(line.rate || 0) * Number(line.qty || 0))} ₽` : '—'}</td>
									{canReceivePurchase && <td><input type="number" min="0" max={Math.max(Number(line.qty || 0) - (receivedByProduct.get(line.productId) ?? 0), 0)} step="any" value={purchaseReceiveLines[String(line.productId)] ?? ''} onChange={(e) => setPurchaseReceiveLines((current) => ({ ...current, [String(line.productId)]: e.target.value === '' ? '' : Math.max(0, Math.min(Math.max(Number(line.qty || 0) - (receivedByProduct.get(line.productId) ?? 0), 0), Number(e.target.value))) }))} /><small>осталось {Math.max(Number(line.qty || 0) - (receivedByProduct.get(line.productId) ?? 0), 0)}</small></td>}
									{canCreatePurchaseTransfer && <td>{transferMax > 0 ? <input type="number" min="0" max={transferMax} step="any" value={purchaseTransferLines[String(line.productId)] ?? ''} onChange={(e) => setPurchaseTransferLines((current) => ({ ...current, [String(line.productId)]: e.target.value === '' ? '' : Math.max(0, Math.min(transferMax, Number(e.target.value))) }))} /> : '—'}</td>}
									<td>{purchaseLines.length > 1 && <button className="supply-document-remove-line" type="button" title="Удалить позицию" aria-label="Удалить позицию" onClick={() => setPurchaseLines((current) => current.filter((row) => row.key !== line.key))}>×</button>}</td>
								</tr>;
							})}
						</tbody></table>
					</div>
					{currentPurchase.receipts.length > 0 && <section className="supply-document-receipts"><h3>Оприходования</h3>{currentPurchase.receipts.map((receipt) => <div key={receipt.name}><b>{receipt.name}</b><span>{documentAmount(receipt.lines)}</span><small>{receipt.lines.map(lineTitle).join(' · ')}</small></div>)}</section>}
					<footer className="supply-document-modal-footer">
						<div>{canDelete && <button className="danger" type="button" disabled={busy} onClick={onDelete}>Удалить</button>}<select value={purchaseStage} onChange={(e) => setPurchaseStage(e.target.value as SupplyPurchaseStage)}>{PURCHASE_STAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
						<div><button type="button" disabled={!purchaseLines.some((line) => Number(line.qty || 0) > 0)} onClick={() => window.print()}>Печать заявки</button>{canCreatePurchaseTransfer && <button type="button" disabled={busy || !purchaseTransferPayload.length} title={`Создать перемещение на ${order.toStore}`} onClick={() => onCreatePurchaseTransfer(purchaseTransferPayload)}>{busy ? 'Провожу...' : 'Создать перемещение'}</button>}{canReceivePurchase && <button type="button" disabled={busy || !receivePurchasePayload.length} title="Оприходовать фактически полученное на Склад Прихода" onClick={() => onReceivePurchase(receivePurchasePayload)}>{busy ? 'Провожу...' : 'Оприходовать'}</button>}<button type="button" onClick={onClose}>Закрыть</button><button className="primary" type="button" disabled={busy || !supplier.trim() || !purchaseLines.some((line) => Number(line.qty || 0) > 0)} onClick={() => onSavePurchase(supplier.trim(), purchaseLines.filter((line) => Number(line.qty || 0) > 0).map(({ productId, itemName, qty, rate }) => ({ productId, itemName, qty: Number(qty || 0), rate: Number(rate || 0) })), purchaseStage, expectedAt)}>{busy ? 'Сохраняю...' : 'Сохранить'}</button></div>
					</footer>
				</section>
				<SupplyPurchasePrint order={order} name={currentPurchase.name} supplier={supplier} expectedAt={expectedAt} lines={purchaseLines.filter((line) => Number(line.qty || 0) > 0).map((line) => ({ productId: line.productId, itemName: line.itemName, qty: Number(line.qty || 0), rate: Number(line.rate || 0) }))} />
			</div>
		);
	}

	const { order, transfer } = document;
	const status = transferStatus(transfer);
	const collectedByProduct = new Map((transfer.collectedLines ?? []).map((line) => [line.productId, line.qty]));
	const acceptedByProduct = new Map((transfer.acceptedLines ?? transfer.receivedLines ?? []).map((line) => [line.productId, line.qty]));
	const canEditDestination = ['draft', 'collected', 'requested'].includes(transfer.status);
	const canEditPlan = ['draft', 'collected', 'accepted', 'requested'].includes(transfer.status);
	const quantitiesMatch = transfer.lines.every((line) => Math.abs(line.qty - (collectedByProduct.get(line.productId) ?? 0)) < 0.000001);
	const acceptedMatchesPlan = transfer.lines.every((line) => Math.abs(line.qty - (acceptedByProduct.get(line.productId) ?? 0)) < 0.000001);
	const planPayload = transfer.lines.map((line) => ({ productId: line.productId, qty: Number(plannedLines[String(line.productId)] || 0) }));
	const planDirty = planPayload.some((line) => Math.abs(line.qty - (transfer.lines.find((current) => current.productId === line.productId)?.qty ?? 0)) >= 0.000001);
	const collectPayload = transfer.lines.map((line) => ({ productId: line.productId, qty: Number(collectLines[String(line.productId)] || 0) }));
	const receivePayload = transfer.lines.map((line) => ({ productId: line.productId, qty: Number(receiveLines[String(line.productId)] || 0) }));
	const selectableStores = destinationStores.includes(transfer.toStore) ? destinationStores : [transfer.toStore, ...destinationStores];
	return (
		<div className="supply-proto-overlay">
			<section className="supply-proto-modal supply-document-modal" role="dialog" aria-modal="true" aria-label={`Перемещение ${transferDocumentLabel(transfer)}`}>
				<header>
						<div><span className="supply-document-eyebrow">Перемещение</span><h2>{transferDocumentLabel(transfer)}</h2><p>{transfer.fromStore} → {transfer.toStore}{order.standalone ? ' · без сделки' : ` · сделка #${order.dealId}`}</p></div>
					<div className="supply-document-modal-head"><span>{status.label}</span>{transferHasDiscrepancy(transfer) && <span className="supply-discrepancy">Расхождение</span>}<button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button></div>
				</header>
				<div className="transfer-destination">
					<div className="transfer-destination-field"><span>Откуда</span><strong>{transfer.fromStore}</strong></div>
					<span className="transfer-destination-arrow" aria-hidden="true">→</span>
					<div className="transfer-destination-field"><span>Куда</span>{canEditDestination
						? <select value={toStore} disabled={savingDestination} onChange={(event) => setToStore(event.target.value)}>{selectableStores.filter((store) => store !== transfer.fromStore).map((store) => <option key={store} value={store}>{store}</option>)}</select>
						: <strong>{transfer.toStore}</strong>}</div>
					{canEditDestination && <button className="transfer-destination-save" type="button" disabled={savingDestination || !toStore || toStore === transfer.toStore} onClick={() => void saveDestination()}>{savingDestination ? 'Сохраняю...' : 'Изменить'}</button>}
				</div>
				{destinationError && <p className="supply-standalone-error">{destinationError}</p>}
				<dl className="supply-document-facts">
					<div><dt>Позиций</dt><dd>{transfer.lines.length}</dd></div>
					<div><dt>Количество</dt><dd>{transfer.lines.reduce((sum, line) => sum + line.qty, 0)}</dd></div>
					<div><dt>Сделка</dt><dd>{order.standalone ? 'Без сделки' : `#${order.dealId}`}</dd></div>
					<div><dt>Основание</dt><dd>{transfer.purchaseOrder || order.name}</dd></div>
				</dl>
				<div className="supply-document-lines">
					<table><thead><tr><th>Наименование</th><th>Количество</th><th>Собрано</th><th>Принято</th></tr></thead><tbody>
						{transfer.lines.map((line, index) => <tr key={`${line.productId}-${index}`}>
							<td><b>{line.name || `#${line.productId}`}</b><small>#{line.productId}</small></td>
							<td>{canEditPlan ? <input type="number" min="0" step="any" value={plannedLines[String(line.productId)] ?? ''} onChange={(e) => setPlannedLines((current) => ({ ...current, [String(line.productId)]: numericDraft(e.target.value) }))} /> : line.qty}</td>
							<td>{transfer.status === 'draft' || transfer.status === 'requested' ? <input type="number" min="0" max={line.qty} step="any" value={collectLines[String(line.productId)] ?? ''} onChange={(e) => setCollectLines((current) => ({ ...current, [String(line.productId)]: e.target.value === '' ? '' : Math.max(0, Math.min(line.qty, Number(e.target.value))) }))} /> : (collectedByProduct.get(line.productId) ?? '—')}</td>
							<td>{transfer.status === 'in_transit' ? <input type="number" min="0" step="any" value={receiveLines[String(line.productId)] ?? ''} onChange={(e) => setReceiveLines((current) => ({ ...current, [String(line.productId)]: e.target.value === '' ? '' : Math.max(0, Number(e.target.value)) }))} /> : (acceptedByProduct.get(line.productId) ?? '—')}</td>
						</tr>)}
					</tbody></table>
				</div>
				{historyOpen && <section className="supply-document-receipts"><h3>История</h3>{[...(transfer.history ?? [])].reverse().map((event, index) => <div key={`${event.at}-${index}`}><b>{new Date(event.at).toLocaleString('ru-RU')} · {event.byName || 'Система'}</b><span>{transferHistoryLabel(event)}</span>{event.changes?.length ? <small>{event.changes.map((change) => `${change.name}: ${change.from} → ${change.to}`).join(' · ')}</small> : null}</div>)}</section>}
				<footer className="supply-document-modal-footer">
					<div>{canDelete && <button className="danger" type="button" disabled={busy} onClick={onDelete}>Удалить</button>}{['draft', 'collected', 'requested'].includes(transfer.status) && <button className="danger" type="button" disabled={busy} onClick={onCancelTransfer}>Отменить</button>}<button type="button" onClick={() => setHistoryOpen((open) => !open)}>История</button></div>
					<div>
						<button type="button" onClick={onClose}>Закрыть</button>
						{canEditPlan && <button type="button" disabled={busy || !planDirty} onClick={() => onUpdateTransfer(planPayload)}>{busy ? 'Сохраняю...' : 'Сохранить количество'}</button>}
						{(transfer.status === 'draft' || transfer.status === 'requested') && <button className="primary" type="button" disabled={busy || planDirty} title={planDirty ? 'Сначала сохрани количество' : ''} onClick={() => onCollectTransfer(collectPayload)}>{busy ? 'Сохраняю...' : 'Собрано'}</button>}
						{transfer.status === 'collected' && <button className="primary" type="button" disabled={busy || planDirty || !quantitiesMatch} title={planDirty ? 'Сначала сохрани количество' : quantitiesMatch ? '' : 'Снабжению нужно скорректировать количество по факту сборки'} onClick={onShipTransfer}>{busy ? 'Провожу...' : 'Отправлено'}</button>}
						{transfer.status === 'in_transit' && <button className="primary" type="button" disabled={busy} onClick={() => onReceiveTransfer(receivePayload)}>{busy ? 'Сохраняю...' : 'Принять'}</button>}
						{transfer.status === 'accepted' && <button className="primary" type="button" disabled={busy || planDirty || !acceptedMatchesPlan} title={planDirty ? 'Сначала сохрани количество' : acceptedMatchesPlan ? '' : 'Скорректируй количество по факту приемки'} onClick={onPostTransfer}>{busy ? 'Провожу...' : transferHasDiscrepancy(transfer) ? 'Провести и скорректировать' : 'Провести'}</button>}
						{transfer.status === 'shortage' && <button className="primary" type="button" disabled={busy} onClick={onResolveShortage}>{busy ? 'Провожу...' : 'Завершить недовоз'}</button>}
					</div>
				</footer>
			</section>
		</div>
	);
}

function DecisionRows({
	order,
	item,
	index,
	decisions,
	suppliers,
	onCreateSupplier,
	onPatch,
	onAdd,
	onRemove,
}: {
	order: SupplyOrderRow;
	item: SupplyOrderItem;
	index: number;
	decisions: DecisionState[];
	suppliers: string[];
	onCreateSupplier: (name: string) => Promise<string>;
	onPatch: (id: string, patch: Partial<DecisionState>) => void;
	onAdd: () => void;
	onRemove: (id: string) => void;
}): JSX.Element {
	const entries = stockEntries(item).filter(([store]) => store !== order.toStore);
	const assigned = decisions.filter(decisionReady).reduce((sum, decision) => sum + decision.qty, 0);
	const covered = Math.min(assigned, item.qty);
	const surplus = Math.max(assigned - item.qty, 0);
	return (
		<>
			{decisions.map((decision, allocationIndex) => {
				const selectedStock = entries.find(([name]) => name === decision.fromStore)?.[1] ?? 0;
				const otherFromStore = decisions
					.filter((row) => row.id !== decision.id && row.action === 'transfer' && row.fromStore === decision.fromStore)
					.reduce((sum, row) => sum + row.qty, 0);
				const otherTransfers = decisions
					.filter((row) => row.id !== decision.id && row.action === 'transfer')
					.reduce((sum, row) => sum + row.qty, 0);
				const qtyMax = decision.action === 'transfer'
					? Math.max(0, Math.min(selectedStock - otherFromStore, item.qty - otherTransfers))
					: undefined;
				const clampQty = (value: number): number => decision.action === 'transfer'
					? Math.max(1, Math.min(qtyMax || 1, value || 1))
					: Math.max(1, value || 1);
				return (
					<tr key={decision.id} className={allocationIndex > 0 ? 'supply-allocation-extra' : ''}>
						{allocationIndex === 0 && (
							<>
								<td className="supply-order-line-main" rowSpan={decisions.length}>
									<b>{item.itemName || `#${item.productId}`}</b>
									<small>{item.note || `строка ${index + 1}`}</small>
									<div className={`supply-allocation-progress${covered >= item.qty ? ' complete' : ''}`}>
										<span>Распределено {covered} из {item.qty}</span>
										{surplus > 0 && <span className="surplus">запас +{surplus}</span>}
									</div>
									<button className="supply-add-allocation" type="button" onClick={onAdd}>+ Добавить источник</button>
								</td>
								<td rowSpan={decisions.length}><b>{item.qty}</b></td>
								<td className={entries.length ? '' : 'muted'} rowSpan={decisions.length}>{compactStock(item)}</td>
							</>
						)}
						<td>
							<select value={decision.action} onChange={(e) => onPatch(decision.id, { action: e.target.value as SupplyDecisionAction | '', qty: Math.max(1, item.qty - assigned + (decisionReady(decision) ? decision.qty : 0)), fromStore: '', supplier: '' })}>
								<option value="">не выбрано</option>
								<option value="transfer" disabled={!entries.length || otherTransfers >= item.qty}>перемещение</option>
								<option value="purchase">закупка</option>
							</select>
						</td>
						<td>
							{decision.action === 'transfer' && (
								<select value={decision.fromStore} onChange={(e) => {
									const store = e.target.value;
									const stock = Number(entries.find(([name]) => name === store)?.[1] ?? 0);
									onPatch(decision.id, { fromStore: store, qty: Math.max(1, Math.min(decision.qty || item.qty, stock, item.qty - otherTransfers)) });
								}}>
									<option value="">склад-источник</option>
									{entries.map(([store, qty]) => {
										const used = decisions.filter((row) => row.id !== decision.id && row.action === 'transfer' && row.fromStore === store).reduce((sum, row) => sum + row.qty, 0);
										return <option key={store} value={store} disabled={used >= qty}>{store} · доступно {Math.max(qty - used, 0)}</option>;
									})}
								</select>
							)}
							{decision.action === 'purchase' && (
								<SupplierField id={`suppliers-${order.name}-${index}-${allocationIndex}`} value={decision.supplier} suppliers={suppliers} onChange={(supplier) => onPatch(decision.id, { supplier })} onCreate={onCreateSupplier} />
							)}
							{!decision.action && <span className="muted">выбери действие</span>}
						</td>
						<td>
							<div className="supply-allocation-qty">
								<input type="number" min="1" max={qtyMax} value={decision.qty} onChange={(e) => onPatch(decision.id, { qty: clampQty(Number(e.target.value)) })} />
								{decisions.length > 1 && <button type="button" title="Удалить источник" aria-label="Удалить источник" onClick={() => onRemove(decision.id)}>×</button>}
							</div>
							{decision.action === 'transfer' && decision.fromStore && <small>доступно для этой строки: {qtyMax}</small>}
						</td>
					</tr>
				);
			})}
		</>
	);
}

function SupplyOrderNoteEditor({ order, onSave }: { order: SupplyOrderRow; onSave: (order: SupplyOrderRow, note: string) => Promise<void> }): JSX.Element {
	const [value, setValue] = useState(order.note);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const changed = value.trim() !== order.note.trim();

	async function save(): Promise<void> {
		if (!changed || saving) return;
		setSaving(true); setError('');
		try {
			await onSave(order, value);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Не удалось сохранить комментарий');
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="supply-order-common-note supply-order-note-editor">
			<label><b>Комментарий</b><textarea rows={2} maxLength={500} value={value} placeholder="Общий комментарий к заказу" onChange={(event) => setValue(event.target.value)} /></label>
			<button type="button" disabled={!changed || saving} onClick={() => void save()}>{saving ? 'Сохраняю…' : 'Сохранить'}</button>
			{error && <span className="error">{error}</span>}
		</div>
	);
}

function OrdersView({
	orders,
	sort,
	search,
	expanded,
	decisions,
	suppliers,
	onCreateSupplier,
	busy,
	reviewing,
	creationErrors,
	onSort,
	onToggle,
	onPatch,
	onAdd,
	onRemove,
	onReview,
	onCancelReview,
	onCreate,
	onOpenPurchase,
	onOpenTransfer,
	onPrintApproval,
	onSaveNote,
}: {
	orders: SupplyOrderRow[];
	sort: SortKey;
	search: string;
	expanded: string;
	decisions: DecisionMap;
	suppliers: string[];
	onCreateSupplier: (name: string) => Promise<string>;
	busy: string | null;
	reviewing: string;
	creationErrors: Record<string, string>;
	onSort: (sort: SortKey) => void;
	onToggle: (name: string) => void;
	onPatch: (key: string, id: string, patch: Partial<DecisionState>) => void;
	onAdd: (key: string, qty: number) => void;
	onRemove: (key: string, id: string) => void;
	onReview: (name: string) => void;
	onCancelReview: () => void;
	onCreate: (order: SupplyOrderRow) => void;
	onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void;
	onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void;
	onPrintApproval: (order: SupplyOrderRow) => void;
	onSaveNote: (order: SupplyOrderRow, note: string) => Promise<void>;
}): JSX.Element {
	return (
		<section className="supply-proto-card">
			<div className="supply-proto-card-head">
				<div>
					<h2>Обеспечение и заказы</h2>
					<p>Открой заявку, выбери по каждой строке закупку или перемещение, затем создай документы одним явным действием.</p>
				</div>
				<label className="supply-sort">
					<span>Сортировка</span>
					<select value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
						<option value="dateDesc">сначала новые</option>
						<option value="dateAsc">сначала старые</option>
						<option value="store">по точке</option>
						<option value="deal">по сделке</option>
					</select>
				</label>
			</div>
			<div className="supply-order-list">
				{orders.length === 0 && <div className="empty">{search.trim() ? 'Ничего не найдено.' : 'Заявок пока нет.'}</div>}
				{orders.map((order) => {
					const isOpen = expanded === order.name;
					const items = requestItemsForOrder(order);
					const readyLines = decisionLinesForOrder(order, decisions);
					const transferGroups = decisionGroups(readyLines, 'transfer');
					const purchaseGroups = decisionGroups(readyLines, 'purchase');
					const documentCount = transferGroups.length + purchaseGroups.length;
					const unresolvedCount = items.filter((item, index) => {
						const key = rowKey(order.name, item.productId, index);
						const assigned = decisionsForRow(decisions, key, item.qty).filter(decisionReady).reduce((sum, decision) => sum + decision.qty, 0);
						return assigned < item.qty;
					}).length;
					const incompleteCount = items.reduce((count, item, index) => {
						const key = rowKey(order.name, item.productId, index);
						return count + decisionsForRow(decisions, key, item.qty).filter((decision) => decision.action && !decisionReady(decision)).length;
					}, 0);
					const allocationErrorCount = items.reduce((count, item, index) => {
						const key = rowKey(order.name, item.productId, index);
						const transfers = decisionsForRow(decisions, key, item.qty).filter((decision) => decision.action === 'transfer' && decision.fromStore);
						const transferTotal = transfers.reduce((sum, decision) => sum + decision.qty, 0);
							const stores = new Map<string, number>();
							for (const decision of transfers) stores.set(decision.fromStore, (stores.get(decision.fromStore) ?? 0) + decision.qty);
							const storeErrors = [...stores.entries()].filter(([store, qty]) => qty > Number(item.stocks?.[store] ?? 0)).length;
							const destinationErrors = transfers.filter((decision) => decision.fromStore === order.toStore).length;
							return count + (transferTotal > item.qty ? 1 : 0) + storeErrors + destinationErrors;
					}, 0);
					const canCreate = items.length > 0 && readyLines.length > 0 && incompleteCount === 0 && allocationErrorCount === 0 && Boolean(order.toStore) && !busy;
					const requestState = order.closed
						? { label: 'закрыто', tone: 'ok' as const }
						: items.length
							? { label: `${items.length} строк`, tone: 'warn' as const }
							: { label: 'в исполнении', tone: 'info' as const };
					const isReviewing = reviewing === order.name;
					return (
						<article key={order.name} className={`supply-order-card${isOpen ? ' open' : ''}`}>
							<button className="supply-order-head" type="button" onClick={() => onToggle(order.name)}>
								<div>
									<b>{order.name} · {order.dealTitle || `сделка #${order.dealId}`}</b>
									<small>#{order.dealId} · {order.toStore || 'склад не указан'} · нужно до {order.deadline || 'дата не указана'}</small>
								</div>
								<div className="supply-order-head-meta">
									<Pill tone={requestState.tone}>{requestState.label}</Pill>
									{documentsSummary(order)}
								</div>
							</button>
							{isOpen && (
								<div className="supply-order-body">
									<SupplyOrderNoteEditor order={order} onSave={onSaveNote} />
									<div className="supply-proto-table-wrap">
										<table className="supply-proto-table supply-decision-table">
											<thead><tr><th>Позиция</th><th>Нужно</th><th>Остатки</th><th>Действие</th><th>Откуда / поставщик</th><th>Кол-во</th></tr></thead>
											<tbody>
											{items.length === 0 ? <tr><td colSpan={6} className="empty">{order.closed ? 'Заявка выполнена.' : 'Все позиции распределены. Ожидается исполнение документов.'}</td></tr> : items.map((item, index) => {
													const key = rowKey(order.name, item.productId, index);
													const rowDecisions = decisionsForRow(decisions, key, item.qty);
													const assigned = rowDecisions.filter(decisionReady).reduce((sum, decision) => sum + decision.qty, 0);
													return <DecisionRows key={key} order={order} item={item} index={index} decisions={rowDecisions} suppliers={suppliers} onCreateSupplier={onCreateSupplier} onPatch={(id, patch) => onPatch(key, id, patch)} onAdd={() => onAdd(key, Math.max(item.qty - assigned, 1))} onRemove={(id) => onRemove(key, id)} />;
												})}
											</tbody>
										</table>
									</div>
								<div className="supply-order-docs">
									{(order.purchases ?? []).some((purchase) => !purchaseIsCancelled(purchase)) && <div className="supply-order-printbar"><button type="button" onClick={() => onPrintApproval(order)}>Печать сводной</button></div>}
									{(order.transfers?.length ?? 0) === 0 && (order.purchases?.length ?? 0) === 0
										? <p className="muted">Документов нет.</p>
										: <div className="supply-document-tree">
											{(order.transfers ?? []).filter((transfer) => !transfer.correctionOf).map((transfer) => {
												const status = transferStatus(transfer);
												const corrections = (order.transfers ?? []).filter((candidate) => candidate.correctionOf === transfer.id);
												return (
													<div key={`t-${transfer.id}`} className="supply-document-branch">
														<button className="supply-document-row" type="button" onClick={() => onOpenTransfer(order, transfer)}>
													<div><span className="kind">Перемещение</span><b>{transferDocumentLabel(transfer)}</b><small>{transfer.fromStore} → {transfer.toStore}{transfer.purchaseOrder ? ` · ${transfer.purchaseOrder}` : ''}</small></div>
													<div className="supply-document-meta"><span>{documentAmount(transfer.lines)}</span>{transferHasDiscrepancy(transfer) && <span className="supply-discrepancy">Расхождение</span>}<span className="status">{status.label}</span></div>
														</button>
														{corrections.length > 0 && <div className="supply-correction-list">{corrections.map((correction) => {
															const correctionStatus = transferStatus(correction);
															return <button key={correction.id} className="supply-document-row supply-correction-row" type="button" onClick={() => onOpenTransfer(order, correction)}>
																<div><span className="kind">{correction.correctionKind === 'shortage_return' ? 'Возврат недовоза' : 'Перенос излишка'}</span><b>{transferDocumentLabel(correction)}</b><small>{correction.fromStore} → {correction.toStore}</small></div>
																<div className="supply-document-meta"><span>{documentAmount(correction.lines)}</span><span className="status">{correctionStatus.label}</span></div>
															</button>;
														})}</div>}
													</div>
												);
											})}
											{(order.purchases ?? []).map((purchase) => {
												const status = purchaseStatus(purchase);
												return (
													<div key={`p-${purchase.name}`} className="supply-document-branch">
														<button className="supply-document-row" type="button" onClick={() => onOpenPurchase(order, purchase)}>
															<div><span className="kind">Заявка поставщику</span><b>{purchase.supplier || 'Поставщик не выбран'}</b><small>{purchase.name}</small></div>
															<div className="supply-document-meta"><span>{documentAmount(purchase.lines)}</span><span className="status">{status.label}</span></div>
														</button>
													</div>
												);
											})}
										</div>}
								</div>
								{items.length > 0 && <div className="supply-order-plan">
									<div>
										<b>{readyLines.length ? `Распределений: ${readyLines.length}` : 'Решения ещё не выбраны'}</b>
										<span>
											{allocationErrorCount
												? 'Проверь количество перемещения: превышена потребность или остаток склада.'
												: incompleteCount
												? `Заполни источник ещё в ${incompleteCount} строках.`
												: readyLines.length
													? `Будет создано документов: ${documentCount}${unresolvedCount ? `. Останется в заявке: ${unresolvedCount} позиций.` : '.'}`
													: 'Для каждой нужной строки выбери закупку или перемещение.'}
										</span>
									</div>
									<button className="primary" type="button" disabled={!canCreate} onClick={() => onReview(order.name)}>Создать документы</button>
								</div>}
								{isReviewing && (
									<div className="supply-order-review">
										<div className="supply-order-review-head">
											<div><h3>Проверь документы</h3></div>
											<Pill tone="info">{`${documentCount} документ(а)`}</Pill>
										</div>
										<div className="supply-order-review-list">
											{transferGroups.map((group) => (
												<div key={`transfer-${group.key}`} className="supply-order-review-row">
													<span className="kind">Перемещение</span>
													<div><b>{group.key} → транзит → {order.toStore}</b><small>{group.lines.map(lineTitle).join(' · ')}</small></div>
											<span className="supply-review-status">Черновик</span>
												</div>
											))}
											{purchaseGroups.map((group) => (
												<div key={`purchase-${group.key}`} className="supply-order-review-row">
													<span className="kind">Закупка</span>
													<div><b>{group.key}</b><small>{group.lines.map(lineTitle).join(' · ')}</small></div>
													<span className="supply-review-status">Черновик</span>
												</div>
											))}
										</div>
											{unresolvedCount > 0 && <p className="supply-order-review-note">{unresolvedCount} строк(и) останутся в заявке и не попадут в документы.</p>}
											{creationErrors[order.name] && <p className="supply-order-review-error">{creationErrors[order.name]}</p>}
											<div className="supply-order-review-actions">
											<button type="button" disabled={Boolean(busy)} onClick={onCancelReview}>Вернуться к строкам</button>
											<button className="primary" type="button" disabled={!canCreate} onClick={() => onCreate(order)}>{busy === order.name ? 'Создаю...' : `Подтвердить и создать ${documentCount}`}</button>
										</div>
									</div>
								)}
							</div>
							)}
						</article>
					);
				})}
			</div>
		</section>
	);
}

function TreeView({ orders, onOpenPurchase, onOpenTransfer }: { orders: SupplyOrderRow[]; onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void; onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void }): JSX.Element {
	return (
		<section className="supply-proto-card">
			<div className="supply-proto-card-head">
				<div>
					<h2>Дерево сделок</h2>
					<p>Здесь остаются только реальные документы: заявки поставщику, перемещения и приходы.</p>
				</div>
			</div>
			<div className="supply-proto-tree-list">
				{orders.length === 0 && <div className="empty">Пока нечего показывать.</div>}
				{orders.map((order) => (
					<div key={order.name} className="supply-proto-deal">
						<div className="supply-proto-deal-head">
							<div><b>{order.name}</b><small>#{order.dealId} · {order.dealTitle || order.toStore}</small></div>
							<Pill tone={order.closed ? 'ok' : 'info'}>{order.closed ? 'закрыто' : requestItemsForOrder(order).length ? 'требует решения' : 'в исполнении'}</Pill>
						</div>
						<div className="supply-proto-thread">
							{(order.purchases ?? []).map((purchase) => {
								const status = purchaseStatus(purchase);
								return (
									<div key={`${order.name}-${purchase.name}`} className="supply-proto-node">
									<div className="node-top">
										<div><span className="kind">заявка поставщику</span> <button className="supply-inline-document-link" type="button" onClick={() => onOpenPurchase(order, purchase)}>{purchase.name}</button> · {purchase.supplier || 'поставщик не выбран'}</div>
										<Pill tone={status.tone}>{status.label}</Pill>
										</div>
										<p>{purchase.lines.map(lineTitle).join(' · ')}</p>
										{purchase.receipts.map((receipt) => <p key={receipt.name} className="subline">Приход {receipt.name}: {receipt.lines.map(lineTitle).join(' · ')}</p>)}
									</div>
								);
							})}
							{(order.transfers ?? []).map((transfer) => {
								const status = transferStatus(transfer);
								return (
									<div key={`${order.name}-${transfer.id}`} className={`supply-proto-node${transfer.correctionOf ? ' correction' : ''}`}>
									<div className="node-top">
										<div><span className="kind">{transfer.correctionOf ? 'корректировка' : 'перемещение'}</span> <button className="supply-inline-document-link" type="button" onClick={() => onOpenTransfer(order, transfer)}>{transferDocumentLabel(transfer)}</button> · {transfer.fromStore || 'склад'} → {transfer.toStore || 'точка'}</div>
											<div className="supply-status-pair">{transferHasDiscrepancy(transfer) && <Pill tone="warn">Расхождение</Pill>}<Pill tone={status.tone}>{status.label}</Pill></div>
										</div>
										<p>{transfer.lines.map(lineTitle).join(' · ')}</p>
									</div>
								);
							})}
							{!(order.purchases?.length || order.transfers?.length) && <div className="supply-proto-node dashed"><div className="kind">документов нет</div><p>{requestItemsForOrder(order).map((item) => `${item.itemName} ×${item.qty}`).join(' · ') || 'заявка закрыта'}</p></div>}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

type RegistryRow =
	| { kind: 'purchase'; order: SupplyOrderRow; purchase: SupplyPurchaseChild }
	| { kind: 'logistics'; order: SupplyOrderRow; transfer: SupplyTransferChild };

function RegistryView({ orders, kind, search, onOpenPurchase, onOpenTransfer }: { orders: SupplyOrderRow[]; kind: 'purchase' | 'logistics'; search: string; onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void; onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void }): JSX.Element {
	const rows: RegistryRow[] = (kind === 'purchase'
		? orders.flatMap((order) => (order.purchases ?? []).map((purchase) => ({ kind: 'purchase' as const, order, purchase })))
		: orders.flatMap((order) => (order.transfers ?? []).map((transfer) => ({ kind: 'logistics' as const, order, transfer }))))
		.filter((row) => row.kind === 'purchase'
			? searchMatches(search, purchaseSearchValues(row.order, row.purchase))
			: searchMatches(search, transferSearchValues(row.order, row.transfer)));
	return (
		<section className="supply-proto-card">
			<div className="supply-proto-card-head">
				<div>
					<h2>{kind === 'purchase' ? 'Закупки' : 'Логистика'}</h2>
					<p>Отдельный реестр документов без дерева.</p>
				</div>
			</div>
			<div className="supply-proto-table-wrap">
					<table className="supply-proto-table">
						<thead><tr><th>Документ</th><th>Сделка</th><th>Маршрут / поставщик</th><th>Позиции</th><th>Статус</th></tr></thead>
						<tbody>
							{rows.length === 0 ? <tr><td colSpan={5} className="empty">{search.trim() ? 'Ничего не найдено.' : 'Пока пусто.'}</td></tr> : rows.map((row) => {
								if (row.kind === 'purchase') {
									const status = purchaseStatus(row.purchase);
									return <tr key={`${row.order.name}-${row.purchase.name}`}><td><button className="supply-table-document-link" type="button" onClick={() => onOpenPurchase(row.order, row.purchase)}>{row.purchase.name}</button></td><td>{row.order.standalone ? 'Без сделки' : `#${row.order.dealId}`}</td><td>{row.purchase.supplier || 'поставщик не выбран'}</td><td>{row.purchase.lines.map(lineTitle).join(' · ')}</td><td><Pill tone={status.tone}>{status.label}</Pill></td></tr>;
								}
								const status = transferStatus(row.transfer);
								return <tr key={`${row.order.name}-${row.transfer.id}`}><td><button className="supply-table-document-link" type="button" onClick={() => onOpenTransfer(row.order, row.transfer)}>{transferDocumentLabel(row.transfer)}</button></td><td>{row.order.standalone ? 'Без сделки' : `#${row.order.dealId}`}</td><td>{row.transfer.fromStore} → {row.transfer.toStore}</td><td>{row.transfer.lines.map(lineTitle).join(' · ')}</td><td><div className="supply-status-pair">{transferHasDiscrepancy(row.transfer) && <Pill tone="warn">Расхождение</Pill>}<Pill tone={status.tone}>{status.label}</Pill></div></td></tr>;
							})}
						</tbody>
					</table>
				</div>
		</section>
	);
}

type StandaloneDocumentKind = 'purchase' | 'transfer' | 'issue' | 'receipt';
interface StandaloneLine {
	productId: number;
	name: string;
	stocks: Record<string, number>;
	qty: NumericDraft;
	rate: NumericDraft;
	retail: NumericDraft;
}

function StandaloneDocumentModal({ kind, suppliers, mock, onCreateSupplier, onClose, onDone }: { kind: StandaloneDocumentKind; suppliers: string[]; mock: boolean; onCreateSupplier: (name: string) => Promise<string>; onClose: () => void; onDone: (message: string, view: ViewKey) => void }): JSX.Element {
	const [stores, setStores] = useState<string[]>([]);
	const [fromStore, setFromStore] = useState('');
	const [toStore, setToStore] = useState('');
	const [supplier, setSupplier] = useState('');
	const [expectedAt, setExpectedAt] = useState(() => new Date().toISOString().slice(0, 10));
	const [reason, setReason] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<StandaloneLine[]>([]);
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	useEffect(() => {
		if (mock) {
			setStores(['Максидом Дунайский 64', 'Максидом Богатырский 15', 'Максидом ул. Фаворского 12']);
			return;
		}
		void fetchStockFormData().then((data) => setStores(data.stores.filter((name) => !name.toLowerCase().includes('транзит')))).catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [mock]);

	const addPickedLines = (items: Array<{ productId: number; name: string; quantity: number; price: number; purchasePrice?: number; stocks?: Record<string, number> }>): void => {
		setLines((current) => {
			const next = [...current];
			for (const item of items) {
				const index = next.findIndex((line) => line.productId === item.productId);
				if (index >= 0) {
					const existing = next[index];
					if (existing) next[index] = { ...existing, stocks: item.stocks ?? existing.stocks, qty: Number(existing.qty || 0) + item.quantity };
				} else {
					next.push({
						productId: item.productId,
						name: item.name,
						stocks: item.stocks ?? {},
						qty: item.quantity,
						rate: kind === 'purchase' || kind === 'receipt' ? Number(item.purchasePrice ?? 0) : 0,
						retail: kind === 'receipt' ? Number(item.price ?? 0) : 0,
					});
				}
			}
			return next;
		});
	};

	const patchLine = (productId: number, patch: Partial<Pick<StandaloneLine, 'qty' | 'rate' | 'retail'>>): void => {
		setLines((current) => current.map((line) => line.productId === productId ? { ...line, ...patch } : line));
	};

	const submit = async (): Promise<void> => {
		setError('');
		const validLines = lines.filter((line) => Number(line.qty || 0) > 0);
		if (!validLines.length) { setError('Добавь хотя бы одну позицию.'); return; }
		if (kind === 'purchase' && (!supplier.trim() || supplier.trim() === 'Поставщик не выбран')) { setError('Выбери поставщика.'); return; }
		if (kind === 'receipt' && !toStore) { setError('Выбери склад оприходования.'); return; }
		if (kind === 'issue' && !fromStore) { setError('Выбери склад списания.'); return; }
		if (kind === 'transfer') {
			if (!fromStore || !toStore) { setError('Выбери склад отправки и склад получения.'); return; }
			if (fromStore === toStore) { setError('Склады отправки и получения должны отличаться.'); return; }
		}
		if (kind === 'transfer' || kind === 'issue') {
			const unavailable = validLines.find((line) => Number(line.qty || 0) > Number(line.stocks[fromStore] ?? 0));
			if (unavailable) { setError(`На складе «${fromStore}» доступно ${Number(unavailable.stocks[fromStore] ?? 0)}: ${unavailable.name}.`); return; }
		}
		setBusy(true);
		try {
			if (kind === 'purchase') {
				const name = await createStandaloneSupplyPurchase(supplier.trim(), expectedAt, validLines.map((line) => ({ productId: line.productId, itemName: line.name, qty: Number(line.qty), rate: Number(line.rate || 0) })));
				onDone(`${name}: создан самостоятельный черновик.`, 'purchase');
				return;
			}
			if (kind === 'receipt') {
				const name = await createReceiptDoc({
					toStore,
					...(supplier.trim() && supplier.trim() !== 'Поставщик не выбран' ? { supplier: supplier.trim() } : {}),
					...(note.trim() ? { note: note.trim() } : {}),
					lines: validLines.map((line) => ({ productId: line.productId, qty: Number(line.qty), purchase: Number(line.rate || 0), retail: Number(line.retail || 0) })),
				});
				onDone(`${name}: создан черновик оприходования.`, 'receipt');
				return;
			}
			if (kind === 'issue') {
				const name = await createIssueDoc({
					fromStore,
					...(reason.trim() ? { reason: reason.trim() } : {}),
					...(note.trim() ? { note: note.trim() } : {}),
					lines: validLines.map((line) => ({ productId: line.productId, qty: Number(line.qty) })),
				});
				onDone(`${name}: создан черновик списания.`, 'issue');
				return;
			}
			const transfer = await createManualTransfer({ fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines.map((line) => ({ productId: line.productId, name: line.name, qty: Number(line.qty) })) });
			onDone(`Перемещение #${transfer.id}: создан черновик.`, 'logistics');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const documentTitle = kind === 'purchase' ? 'Заявка поставщику'
		: kind === 'transfer' ? 'Перемещение'
			: kind === 'issue' ? 'Списание'
				: 'Оприходование';
	const pickerTitle = kind === 'purchase' ? 'Подобрать товары в заявку поставщику'
		: kind === 'transfer' ? 'Подобрать товары для перемещения'
			: kind === 'issue' ? 'Подобрать товары для списания'
				: 'Подобрать товары для оприходования';

	if (pickingProducts) {
		return (
			<div className="supply-product-picker-overlay">
				<ProductBase picker={{
					title: pickerTitle,
					kindFilter: 'goods',
					onlyStockDefault: false,
					onCancel: () => setPickingProducts(false),
					onDone: async (items) => {
						addPickedLines(items);
						setPickingProducts(false);
					},
				}} />
			</div>
		);
	}

	return (
		<div className="supply-proto-overlay">
			<section className="supply-proto-modal supply-standalone-modal" role="dialog" aria-modal="true" aria-label={`Новое ${documentTitle.toLowerCase()}`}>
				<header><div><h2>{documentTitle}</h2><p>Самостоятельный документ без сделки и заявки.</p></div><button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button></header>
				<div className="supply-standalone-fields">
					{kind === 'purchase' ? <>
						<SupplierField id="standalone-purchase-supplier" label="Поставщик" value={supplier} suppliers={suppliers} onChange={setSupplier} onCreate={onCreateSupplier} />
						<label>Ожидаемая дата<input type="date" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} /></label>
					</> : kind === 'transfer' ? <>
						<label>Склад отправки<select value={fromStore} onChange={(event) => setFromStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<label>Склад получения<select value={toStore} onChange={(event) => setToStore(event.target.value)}><option value="">Выбери склад</option>{stores.filter((name) => name !== fromStore).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
					</> : kind === 'issue' ? <>
						<label>Склад списания<select value={fromStore} onChange={(event) => setFromStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<label>Причина<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Брак, недостача, внутренние нужды" /></label>
					</> : <>
						<label>Склад оприходования<select value={toStore} onChange={(event) => setToStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<SupplierField id="standalone-receipt-supplier" label="Поставщик (необязательно)" value={supplier} suppliers={suppliers} onChange={setSupplier} onCreate={onCreateSupplier} />
					</>}
				</div>
				<div className="supply-standalone-product-actions">
					<button type="button" onClick={() => setPickingProducts(true)}>Подобрать товары</button>
					<span>{lines.length ? `Выбрано позиций: ${lines.length}` : 'Позиции ещё не выбраны'}</span>
				</div>
				<div className="supply-document-lines supply-standalone-lines">
					<table><thead><tr><th>Позиция</th><th>Количество</th>{kind === 'purchase' && <th>Цена</th>}{kind === 'receipt' && <><th>Закупочная цена</th><th>Розничная цена</th></>}<th aria-label="Удалить" /></tr></thead><tbody>
						{lines.length === 0 ? <tr><td colSpan={kind === 'receipt' ? 5 : kind === 'purchase' ? 4 : 3} className="empty">Позиции не добавлены.</td></tr> : lines.map((line) => <tr key={line.productId}><td><b>{line.name}</b><small>#{line.productId}{(kind === 'transfer' || kind === 'issue') && fromStore ? ` · доступно ${Number(line.stocks[fromStore] ?? 0)}` : ''}</small></td><td><input type="number" min="0" step="any" value={line.qty} onChange={(event) => patchLine(line.productId, { qty: numericDraft(event.target.value) })} /></td>{(kind === 'purchase' || kind === 'receipt') && <td><input type="number" min="0" step="any" value={line.rate} onChange={(event) => patchLine(line.productId, { rate: numericDraft(event.target.value) })} /></td>}{kind === 'receipt' && <td><input type="number" min="0" step="any" value={line.retail} onChange={(event) => patchLine(line.productId, { retail: numericDraft(event.target.value) })} /></td>}<td><button className="supply-document-remove-line" type="button" title="Удалить позицию" aria-label="Удалить позицию" onClick={() => setLines((current) => current.filter((row) => row.productId !== line.productId))}>×</button></td></tr>)}
					</tbody></table>
				</div>
				{(kind === 'transfer' || kind === 'issue' || kind === 'receipt') && <label className="supply-standalone-search">Комментарий<input value={note} onChange={(event) => setNote(event.target.value)} /></label>}
				{error && <div className="supply-standalone-error">{error}</div>}
				<footer><button type="button" onClick={onClose}>Отмена</button><button className="primary" type="button" disabled={busy} onClick={() => void submit()}>{busy ? 'Создаю...' : 'Создать'}</button></footer>
			</section>
		</div>
	);
}

export function Supply(): JSX.Element {
	const ctx = getContext();
	const query = new URLSearchParams(window.location.search);
	const requestId = Number(query.get('request') ?? ctx.requestId ?? 0);
	const transferDeepLinkId = Number(query.get('transfer') ?? ctx.transferId ?? 0);
	const dealSupplyId = Number(query.get('dealSupply') ?? ctx.dealSupplyId ?? 0);
	const linkTarget = query.get('target') ?? ctx.linkTarget ?? '';
	const [phase, setPhase] = useState<Phase>('init');
	const [orders, setOrders] = useState<SupplyOrderRow[]>(ctx.__mock ? MOCK_ORDERS : []);
	const [suppliers, setSuppliers] = useState<string[]>(DEFAULT_SUPPLIERS);
	const [loading, setLoading] = useState(!ctx.__mock);
	const [view, setView] = useState<ViewKey>(requestId > 0 ? 'incoming' : 'orders');
	const [sort, setSort] = useState<SortKey>('dateDesc');
	const [expanded, setExpanded] = useState('');
	const [decisions, setDecisions] = useState<DecisionMap>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [reviewing, setReviewing] = useState('');
	const [openDocument, setOpenDocument] = useState<OpenSupplyDocument | null>(null);
	const [documentBusy, setDocumentBusy] = useState(false);
	const [currentUserId, setCurrentUserId] = useState('');
	const [notice, setNotice] = useState<string | null>(null);
	const [creationErrors, setCreationErrors] = useState<Record<string, string>>({});
	const [createKind, setCreateKind] = useState<StandaloneDocumentKind | null>(null);
	const [printApprovalOrder, setPrintApprovalOrder] = useState<SupplyOrderRow | null>(null);
	const [searches, setSearches] = useState<Record<ViewKey, string>>({ orders: '', incoming: '', purchase: '', logistics: '', stocks: '', issue: '', receipt: '', delivery: '', return: '', ledger: '' });
	const [stockRefresh, setStockRefresh] = useState(0);
	const [stockForm, setStockForm] = useState<Awaited<ReturnType<typeof fetchStockFormData>> | null>(ctx.__mock
		? { stores: ['Максидом Дунайский 64', 'Максидом Богатырский 15', 'Максидом ул. Фаворского 12'], suppliers: DEFAULT_SUPPLIERS, canCreate: true, isSupply: true }
		: null);
	const [deepLinkHandled, setDeepLinkHandled] = useState(false);

	useEffect(() => {
		if (!printApprovalOrder) return;
		const clear = (): void => setPrintApprovalOrder(null);
		let fallback = 0;
		const frame = window.requestAnimationFrame(() => {
			window.print();
			fallback = window.setTimeout(clear, 1000);
		});
		window.addEventListener('afterprint', clear, { once: true });
		return () => {
			window.cancelAnimationFrame(frame);
			window.clearTimeout(fallback);
			window.removeEventListener('afterprint', clear);
		};
	}, [printApprovalOrder]);

	const reload = async (): Promise<void> => {
		const loaded = await fetchSupplyOrders();
		setOrders(loaded);
	};

	const saveOrderNote = async (order: SupplyOrderRow, note: string): Promise<void> => {
		const saved = ctx.__mock ? note.trim() : await updateSupplyOrderNote(order.name, note);
		setOrders((current) => current.map((row) => row.name === order.name ? { ...row, note: saved } : row));
		setNotice(`${order.name}: комментарий сохранён.`);
	};

	const addSupplier = async (name: string): Promise<string> => {
		const clean = name.trim();
		if (ctx.__mock) {
			setSuppliers((current) => [...new Set([...current, clean])].sort((a, b) => a.localeCompare(b, 'ru')));
			return clean;
		}
		const result = await createSupplySupplier(clean);
		const next = [...new Set([...result.suppliers, ...DEFAULT_SUPPLIERS])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
		setSuppliers(next);
		setStockForm((current) => current ? { ...current, suppliers: next } : current);
		setNotice(result.created ? `Поставщик «${result.name}» создан.` : `Поставщик «${result.name}» уже есть в справочнике.`);
		return result.name;
	};

	const refreshOpenDocument = async (target: OpenSupplyDocument): Promise<void> => {
		const loaded = await fetchSupplyOrders();
		setOrders(loaded);
		const order = loaded.find((row) => row.name === target.order.name);
		if (!order) { setOpenDocument(null); return; }
		if (target.kind === 'purchase') {
			const purchase = (order.purchases ?? []).find((row) => row.name === target.purchase.name);
			setOpenDocument(purchase ? { kind: 'purchase', order, purchase } : null);
			return;
		}
		const transfer = (order.transfers ?? []).find((row) => row.id === target.transfer.id);
		setOpenDocument(transfer ? { kind: 'transfer', order, transfer } : null);
	};

	const saveOpenPurchase = async (supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>, stage: SupplyPurchaseStage, expectedAt: string): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy) return;
		setDocumentBusy(true);
		try {
			await updateSupplyPurchaseOrder(target.purchase.name, supplier, lines);
			if (stage !== (target.purchase.supplyStage || 'draft') || expectedAt !== (target.purchase.expectedAt || '')) {
				await updateSupplyPurchaseStage(target.purchase.name, stage, expectedAt);
			}
			await refreshOpenDocument(target);
			setNotice(`${target.purchase.name}: сохранено, статус «${PURCHASE_STAGE_OPTIONS.find((option) => option.value === stage)?.label ?? stage}».`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось сохранить заявку поставщику.');
		} finally { setDocumentBusy(false); }
	};

	const receiveOpenPurchase = async (lines: Array<{ productId: number; qty: number; rate: number }>): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy || !lines.length) return;
		setDocumentBusy(true);
		try {
			const receipt = await receiveSupplyPurchase(target.order.name, target.order.requestKey, Number(target.order.dealId), target.purchase.name, lines);
			await refreshOpenDocument(target);
			setNotice(`${receipt}: оприходовано на Склад Прихода.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось оприходовать закупку.');
		} finally { setDocumentBusy(false); }
	};

	const createOpenPurchaseTransfer = async (lines: Array<{ productId: number; qty: number }>): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy || !lines.length) return;
		setDocumentBusy(true);
		try {
			const transfer = await createSupplyPurchaseTransfer(target.order.name, target.order.requestKey, Number(target.order.dealId), target.purchase.name, lines);
			await refreshOpenDocument(target);
			setNotice(`${transferDocumentLabel(transfer)}: создан черновик перемещения на ${target.order.toStore}.`);
		} catch (err) {
			await refreshOpenDocument(target).catch(() => undefined);
			setNotice(err instanceof Error ? err.message : 'Не удалось создать перемещение на точку.');
		} finally { setDocumentBusy(false); }
	};

	const changeOpenTransferDestination = async (toStore: string): Promise<SupplyTransferChild> => {
		const target = openDocument;
		if (!target || target.kind !== 'transfer') throw new Error('перемещение больше не открыто');
		const updated = ctx.__mock
			? { ...target.transfer, toStore, name: `Перемещение #${target.order.dealId}: ${target.transfer.fromStore} → ${toStore}` }
			: await updateTransferDestination(target.transfer.id, toStore);
		const nextTransfer: SupplyTransferChild = { ...target.transfer, name: updated.name, toStore: updated.toStore };
		const patchOrder = (order: SupplyOrderRow): SupplyOrderRow => ({
			...order,
			transfers: (order.transfers ?? []).map((transfer) => transfer.id === nextTransfer.id ? nextTransfer : transfer),
		});
		const nextOrder = patchOrder(target.order);
		setOrders((current) => current.map(patchOrder));
		setOpenDocument({ kind: 'transfer', order: nextOrder, transfer: nextTransfer });
		setNotice(`${transferDocumentLabel(nextTransfer)}: склад назначения изменён на «${toStore}».`);
		return nextTransfer;
	};

	const moveOpenTransfer = async (action: 'update' | 'collect' | 'ship' | 'receive' | 'post' | 'cancel' | 'resolve', lines: Array<{ productId: number; qty: number }> = []): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'transfer' || documentBusy) return;
		setDocumentBusy(true);
		try {
			const updated = action === 'update' ? await updateTransferLines(target.transfer.id, lines)
				: action === 'collect' ? await collectTransfer(target.transfer.id, lines)
					: action === 'ship' ? await shipTransfer(target.transfer.id)
						: action === 'receive' ? await receiveTransfer(target.transfer.id, lines)
							: action === 'post' ? await postTransfer(target.transfer.id)
								: action === 'cancel' ? await cancelTransfer(target.transfer.id)
								: await resolveTransferShortage(target.transfer.id);
			await refreshOpenDocument(target);
			setNotice(updated.actionWarning || `${transferDocumentLabel(target.transfer)}: статус обновлён.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось изменить статус перемещения.');
		} finally { setDocumentBusy(false); }
	};

	const deleteOpenDocument = async (): Promise<void> => {
		const target = openDocument;
		if (!target || documentBusy || currentUserId !== '1858') return;
		const title = target.kind === 'purchase' ? target.purchase.name : `Перемещение ${transferDocumentLabel(target.transfer)}`;
		const detail = target.kind === 'purchase'
			? 'Связанные оприходования будут отменены.'
			: 'Все проведённые складские движения и связанные корректировки этого перемещения будут отменены и удалены.';
		if (!window.confirm(`Удалить ${title}?\n\n${detail}`)) return;
		setDocumentBusy(true);
		try {
			if (target.kind === 'purchase') await deleteSupplyPurchaseOrder(target.purchase.name);
			else await deleteTransfer(target.transfer.id);
			setOpenDocument(null);
			await reload();
			setNotice(`${title}: удалено.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось удалить документ.');
		} finally { setDocumentBusy(false); }
	};

	useEffect(() => {
		if (ctx.__mock) { setPhase('ready'); return; }
		const bx = window.BX24;
		if (!bx) {
			setOrders(MOCK_ORDERS);
			setLoading(false);
			setPhase('ready');
			return;
		}
		bx.init(() => {
			void (async () => {
				const [uid, access] = await Promise.all([
					withTimeout(fetchCurrentUserId(), 15000, 'user.current'),
					withTimeout(fetchStockFormData(), 15000, 'stock.form-data'),
				]);
				setCurrentUserId(uid);
				setStockForm(access);
				const hasSmartLink = requestId > 0 || transferDeepLinkId > 0 || dealSupplyId > 0;
				const managerLink = hasSmartLink && (linkTarget === 'manager' || (linkTarget !== 'supply' && !access.isSupply));
				if (managerLink) {
					setLoading(false);
					setPhase('manager-link');
					return;
				}
				if (!access.canCreate) { setLoading(false); setPhase('denied'); return; }
				setPhase('ready');
				try {
					const [loaded, supplierList] = await Promise.all([fetchSupplyOrders(), fetchSupplySuppliers()]);
					setOrders(loaded);
					setSuppliers([...new Set([...supplierList, ...DEFAULT_SUPPLIERS])].filter(Boolean));
				} catch {
					setOrders([]);
				} finally {
					setLoading(false);
				}
			})().catch(() => setPhase('denied'));
		});
	}, [ctx.__mock, dealSupplyId, linkTarget, requestId, transferDeepLinkId]);

	useEffect(() => {
		if (loading || deepLinkHandled) return;
		const queryId = Number(new URLSearchParams(window.location.search).get('transfer') ?? 0);
		const transferId = Number(ctx.transferId ?? queryId);
		if (Number.isInteger(transferId) && transferId > 0) {
			for (const order of orders) {
				const transfer = (order.transfers ?? []).find((row) => row.id === transferId);
				if (!transfer) continue;
				setView('logistics');
				setOpenDocument({ kind: 'transfer', order, transfer });
				break;
			}
		}
		setDeepLinkHandled(true);
	}, [ctx.transferId, deepLinkHandled, loading, orders]);

	useEffect(() => {
		if (loading || dealSupplyId <= 0) return;
		const order = orders.find((item) => Number(item.dealId) === dealSupplyId);
		if (!order) return;
		setView('orders');
		setExpanded(order.name);
	}, [dealSupplyId, loading, orders]);

	const requestOrders = useMemo(() => orders.filter((order) => !order.standalone), [orders]);
	const sortedOrders = useMemo(() => [...requestOrders].sort((a, b) => {
		if (sort === 'dateAsc') return String(a.date).localeCompare(String(b.date));
		if (sort === 'store') return String(a.toStore).localeCompare(String(b.toStore), 'ru');
		if (sort === 'deal') return String(a.dealTitle || a.dealId).localeCompare(String(b.dealTitle || b.dealId), 'ru');
		return String(b.date).localeCompare(String(a.date));
	}), [requestOrders, sort]);
	const filteredOrders = useMemo(
		() => sortedOrders.filter((order) => searchMatches(searches.orders, orderSearchValues(order))),
		[sortedOrders, searches.orders],
	);

	const patchDecision = (key: string, id: string, patch: Partial<DecisionState>): void => {
		setReviewing('');
		setDecisions((current) => {
			const rows = current[key] ?? [{ ...makeDecision(key, 1), id }];
			return { ...current, [key]: rows.map((row) => row.id === id ? { ...row, ...patch } : row) };
		});
	};

	const addDecision = (key: string, qty: number): void => {
		setReviewing('');
		setDecisions((current) => ({ ...current, [key]: [...(current[key] ?? [{ ...makeDecision(key, qty), id: `${key}:initial` }]), makeDecision(key, qty)] }));
	};

	const removeDecision = (key: string, id: string): void => {
		setReviewing('');
		setDecisions((current) => {
			const nextRows = (current[key] ?? []).filter((row) => row.id !== id);
			return { ...current, [key]: nextRows.length ? nextRows : [makeDecision(key, 1)] };
		});
	};

	const createDocs = async (order: SupplyOrderRow): Promise<void> => {
		const lines = decisionLinesForOrder(order, decisions);
		if (!lines.length) {
			setNotice('Выбери действие хотя бы по одной строке заявки.');
			return;
		}
		setBusy(order.name);
		setCreationErrors((current) => ({ ...current, [order.name]: '' }));
		try {
			const transferPlan = decisionGroups(lines, 'transfer');
			const purchasePlan = decisionGroups(lines, 'purchase');
			let createdTransferCount = transferPlan.length;
			let createdPurchaseCount = purchasePlan.length;
			let updatedPurchaseCount = 0;
			if (ctx.__mock) {
				setOrders((current) => current.map((row) => row.name === order.name ? {
					...row,
					items: row.items.map((item) => {
						const covered = lines.filter((line) => line.productId === item.productId).reduce((sum, line) => sum + line.qty, 0);
						return { ...item, qty: Math.max(item.qty - covered, 0) };
					}).filter((item) => item.qty > 0),
					transfers: [...(row.transfers ?? []), ...transferPlan.map((group, i) => ({ id: Date.now() + i, name: `TRN-DEMO-${i + 1}`, status: 'in_transit', fromStore: group.key, toStore: row.toStore, lines: group.lines.map((line) => ({ productId: line.productId, name: line.itemName, qty: line.qty })), receivedLines: [], shortageLines: [] }))],
					purchases: [...(row.purchases ?? []), ...purchasePlan.map((group, i) => ({ name: `PUR-DEMO-${i + 1}`, supplier: group.key, status: 'Draft', supplyStage: 'draft', lines: group.lines.map((line) => ({ productId: line.productId, name: line.itemName, qty: line.qty, rate: 0 })), receipts: [] }))],
				} : row));
			} else {
				const created = await createSupplyDocuments({ requestName: order.name, requestKey: order.requestKey, dealId: Number(order.dealId), toStore: order.toStore, lines });
				createdTransferCount = created.transfers.length;
				createdPurchaseCount = created.purchases.length;
				updatedPurchaseCount = created.updatedPurchases.length;
				await reload();
			}
			setDecisions((current) => {
				const next = { ...current };
				requestItemsForOrder(order).forEach((item, index) => { delete next[rowKey(order.name, item.productId, index)]; });
				return next;
			});
			setReviewing('');
			setCreationErrors((current) => ({ ...current, [order.name]: '' }));
			const parts = [
				createdTransferCount ? `Создано перемещений: ${createdTransferCount} (товар в транзите)` : '',
				createdPurchaseCount ? `Создано заявок поставщику: ${createdPurchaseCount} (черновики)` : '',
				updatedPurchaseCount ? `Дополнено черновиков: ${updatedPurchaseCount}` : '',
			].filter(Boolean);
			setNotice(`Готово. ${parts.join('; ')}.`);
		} catch (err) {
			if (!ctx.__mock) await reload().catch(() => undefined);
			const message = err instanceof Error ? err.message : String(err);
			setCreationErrors((current) => ({ ...current, [order.name]: message }));
			setNotice(message);
		} finally {
			setBusy(null);
		}
	};

	if (phase === 'init') return <div className="supply-proto-state">Загрузка...</div>;
	if (phase === 'manager-link' && (requestId > 0 || transferDeepLinkId > 0)) return <StockLedger />;
	if (phase === 'manager-link' && dealSupplyId > 0) return <DealSupplyFallback dealId={dealSupplyId} />;
	if (phase === 'denied' && (requestId > 0 || transferDeepLinkId > 0)) return <StockLedger />;
	if (phase === 'denied' && dealSupplyId > 0) return <DealSupplyFallback dealId={dealSupplyId} />;
	if (phase === 'denied') return <div className="supply-proto-state">Раздел «Снаб» доступен сотрудникам снабжения.</div>;

	return (
		<div className="supply-proto-shell">
			<aside className="supply-proto-rail">
				<div className="supply-proto-brand"><span>С</span><div><b>Снаб</b><small>рабочий сценарий</small></div></div>
				<button className={view === 'orders' ? 'active' : ''} type="button" onClick={() => setView('orders')}>Обеспечение и заказы</button>
				<button className={view === 'incoming' ? 'active' : ''} type="button" onClick={() => setView('incoming')}>Входящие заявки ТТ</button>
				<button className={view === 'purchase' ? 'active' : ''} type="button" onClick={() => setView('purchase')}>Закупки</button>
				<button className={view === 'logistics' ? 'active' : ''} type="button" onClick={() => setView('logistics')}>Логистика</button>
				<button className={view === 'stocks' ? 'active' : ''} type="button" onClick={() => setView('stocks')}>Остатки</button>
				<button className={view === 'issue' ? 'active' : ''} type="button" onClick={() => setView('issue')}>Списания</button>
				<button className={view === 'receipt' ? 'active' : ''} type="button" onClick={() => setView('receipt')}>Оприходования</button>
				<button className={view === 'delivery' ? 'active' : ''} type="button" onClick={() => setView('delivery')}>Реализации</button>
				<button className={view === 'return' ? 'active' : ''} type="button" onClick={() => setView('return')}>Возвраты</button>
				<button className={view === 'ledger' ? 'active' : ''} type="button" onClick={() => setView('ledger')}>Движение товаров</button>
				<div className="supply-proto-source">Данные: {ctx.__mock ? 'демо' : 'ядро'}<br />Документы: {ctx.__mock ? 'превью' : 'живые'}</div>
			</aside>
			<main className={`supply-proto-main${view === 'stocks' ? ' supply-proto-main-wide' : ''}`}>
				<header className="supply-proto-top">
					<div>
						<h1>Снабжение</h1>
						<p>{view === 'stocks'
							? 'Каталог товаров и актуальные остатки по складам.'
							: view === 'ledger'
							? 'История прихода, перемещения, реализации и инвентаризации по выбранному товару.'
							: view === 'incoming'
								? 'Заявки торговых точек, по которым снабжение должно принять решение.'
							: view === 'logistics'
								? 'Все перемещения: самостоятельные и созданные по заявкам или закупкам.'
								: view === 'issue'
									? 'Списания со склада, с привязкой к сделке там, где она есть.'
									: view === 'receipt'
										? 'Все оприходования: поставщик, склад, состав документа и связанная сделка.'
										: view === 'delivery'
											? 'Реализации товаров по сделкам и самостоятельные документы.'
											: view === 'return'
												? 'Возвраты клиентов с исходной сделкой и составом документа.'
												: 'Заявка раскрывается в строки, снабжение вручную выбирает закупку или перемещение.'}</p>
					</div>
					<div className="supply-proto-actions">
						{view === 'purchase' && <button className="primary" type="button" onClick={() => setCreateKind('purchase')}>Создать заявку поставщику</button>}
						{view === 'logistics' && <button className="primary" type="button" onClick={() => setCreateKind('transfer')}>Создать перемещение</button>}
						{view === 'issue' && <button className="primary" type="button" onClick={() => setCreateKind('issue')}>Создать списание</button>}
						{view === 'receipt' && <button className="primary" type="button" onClick={() => setCreateKind('receipt')}>Создать оприходование</button>}
					</div>
				</header>
				{(view === 'orders' || view === 'purchase' || view === 'logistics') && <Metrics orders={orders} view={view} />}
				{(view === 'orders' || view === 'purchase') && <SupplySearch value={searches[view]} onChange={(value) => setSearches((current) => ({ ...current, [view]: value }))} />}
				{notice && <div className="supply-proto-notice"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Закрыть</button></div>}
				{loading && <div className="supply-proto-card empty">Загрузка заявок из ядра...</div>}
				{view === 'orders' && <OrdersView orders={filteredOrders} sort={sort} search={searches.orders} expanded={expanded} decisions={decisions} suppliers={suppliers} onCreateSupplier={addSupplier} busy={busy} reviewing={reviewing} creationErrors={creationErrors} onSort={setSort} onToggle={(name) => { setReviewing(''); setExpanded((current) => current === name ? '' : name); }} onPatch={patchDecision} onAdd={addDecision} onRemove={removeDecision} onReview={(name) => { setCreationErrors((current) => ({ ...current, [name]: '' })); setReviewing(name); }} onCancelReview={() => setReviewing('')} onCreate={(order) => void createDocs(order)} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} onPrintApproval={setPrintApprovalOrder} onSaveNote={saveOrderNote} />}
				{view === 'purchase' && <RegistryView orders={orders} kind="purchase" search={searches.purchase} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} />}
				{view === 'incoming' && <div className="supply-proto-card supply-stock-card"><TransferRequestsTab key={`requests-${stockRefresh}`} form={stockForm} mode="supply" {...(requestId > 0 ? { initialRequestId: requestId } : {})} onChanged={() => setStockRefresh((value) => value + 1)} /></div>}
				{view === 'logistics' && <>
					<div className="supply-proto-card supply-stock-card"><StockTransfersTab key={`transfers-${stockRefresh}`} form={stockForm} showCreate={false} supplyMode /></div>
				</>}
				{view === 'stocks' && <div className="supply-products-view"><ProductBase readOnly allowCreateProduct /></div>}
				{(view === 'issue' || view === 'receipt' || view === 'delivery' || view === 'return') && <div className="supply-proto-card supply-stock-card"><StockMovementsTab key={`${view}-${stockRefresh}`} kind={view} form={stockForm} showCreate={false} /></div>}
				{view === 'ledger' && <div className="supply-proto-card supply-stock-card"><LedgerTab /></div>}
			</main>
			{createKind && <StandaloneDocumentModal kind={createKind} suppliers={suppliers} mock={Boolean(ctx.__mock)} onCreateSupplier={addSupplier} onClose={() => setCreateKind(null)} onDone={(message, nextView) => { setCreateKind(null); setNotice(message); setView(nextView); setStockRefresh((value) => value + 1); void reload(); }} />}
			{openDocument && <DocumentDetail
				key={openDocument.kind === 'purchase' ? `purchase-${openDocument.purchase.name}` : `transfer-${openDocument.transfer.id}`}
				document={openDocument}
				suppliers={suppliers}
				busy={documentBusy}
				canDelete={currentUserId === '1858'}
				onClose={() => setOpenDocument(null)}
				onDelete={() => void deleteOpenDocument()}
				onCreateSupplier={addSupplier}
				onSavePurchase={(supplier, lines, stage, expectedAt) => void saveOpenPurchase(supplier, lines, stage, expectedAt)}
				onReceivePurchase={(lines) => void receiveOpenPurchase(lines)}
				onCreatePurchaseTransfer={(lines) => void createOpenPurchaseTransfer(lines)}
				onChangeTransferDestination={changeOpenTransferDestination}
				onUpdateTransfer={(lines) => void moveOpenTransfer('update', lines)}
				onCollectTransfer={(lines) => void moveOpenTransfer('collect', lines)}
				onShipTransfer={() => void moveOpenTransfer('ship')}
				onReceiveTransfer={(lines) => void moveOpenTransfer('receive', lines)}
				onPostTransfer={() => void moveOpenTransfer('post')}
				onCancelTransfer={() => { if (window.confirm('Отменить перемещение и освободить резерв?')) void moveOpenTransfer('cancel'); }}
				onResolveShortage={() => void moveOpenTransfer('resolve')}
			/>}
			{printApprovalOrder && <SupplyApprovalPrint order={printApprovalOrder} />}
		</div>
	);
}

function DealSupplyFallback({ dealId }: { dealId: number }): JSX.Element {
	useEffect(() => { openDeal(dealId); }, [dealId]);
	return <div className="supply-proto-state"><button className="btn-primary" type="button" onClick={() => openDeal(dealId)}>Открыть сделку #{dealId}</button></div>;
}
