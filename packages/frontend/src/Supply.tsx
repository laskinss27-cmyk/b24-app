import { useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import {
	BETA_USER_IDS,
	createSupplyDocuments,
	createSupplyPurchaseTransfer,
	deleteSupplyPurchaseOrder,
	deleteTransfer,
	fetchCurrentUserId,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	isPortalAdmin,
	receiveSupplyPurchase,
	receiveTransfer,
	resolveTransferShortage,
	shipTransfer,
	updateSupplyPurchaseOrder,
	updateSupplyPurchaseStage,
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
		status: 'Pending',
		closed: false,
		toStore: 'Максидом Дунайский 64',
		items: [
			{ productId: 16758, itemName: 'IP-камера 4 Мп CTV-IPB2028', qty: 6, note: 'нужно новое, в упаковке', stocks: { Парнас: 2, Офис: 1 } },
			{ productId: 202, itemName: 'Контроллер СКУД ZKTeco', qty: 4, note: '', stocks: {} },
		],
		purchases: [],
		transfers: [],
	},
	{
		name: 'MAT-MR-2026-0002',
		requestKey: 'MAT-MR-2026-0002@demo',
		dealId: '36801',
		dealTitle: 'СКУД офис',
		date: '2026-07-11',
		status: 'Pending',
		closed: false,
		toStore: 'Измайловский 18Д',
		items: [{ productId: 301, itemName: 'Домофон Tantos Prime SD', qty: 3, note: '', stocks: { Офис: 1 } }],
		purchases: [],
		transfers: [],
	},
];

type Phase = 'init' | 'denied' | 'ready';
type ViewKey = 'orders' | 'tree' | 'purchase' | 'logistics' | 'stock';
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
		if (transfer.status === 'canceled') continue;
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
	if (transfer.status === 'received') return { label: 'Получено', tone: 'ok' };
	if (transfer.status === 'shortage') return { label: 'Недовоз', tone: 'warn' };
	if (transfer.status === 'in_transit') return { label: 'В пути', tone: 'info' };
	if (transfer.status === 'canceled') return { label: 'Отменено', tone: 'muted' };
	return { label: 'Создано', tone: 'muted' };
};

const lineTitle = (line: { name?: string; itemName?: string; productId: number; qty: number }): string =>
	`${line.name || line.itemName || `#${line.productId}`} ×${line.qty}`;
const documentAmount = (lines: Array<{ qty: number }>): string => {
	const qty = lines.reduce((sum, line) => sum + Number(line.qty || 0), 0);
	return `${lines.length} поз. · ${qty} шт`;
};

function Pill({ tone, children }: { tone: string; children: string }): JSX.Element {
	return <span className={`supply-proto-pill ${tone}`}>{children}</span>;
}

function Metrics({ orders }: { orders: SupplyOrderRow[] }): JSX.Element {
	const openOrders = orders.filter((order) => !order.closed).length;
	const purchaseCount = orders.reduce((sum, order) => sum + (order.purchases?.length ?? 0), 0);
	const receiptCount = orders.reduce((sum, order) => sum + (order.purchases ?? []).reduce((a, purchase) => a + purchase.receipts.length, 0), 0);
	const transferCount = orders.reduce((sum, order) => sum + (order.transfers?.length ?? 0), 0);
	return (
		<div className="supply-proto-metrics">
			<div><span>Заявки в работе</span><b>{openOrders}</b></div>
			<div><span>Заявки поставщику</span><b>{purchaseCount}</b></div>
			<div><span>Оприходования</span><b>{receiptCount}</b></div>
			<div><span>Перемещения</span><b>{transferCount}</b></div>
		</div>
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

const PURCHASE_STAGE_OPTIONS: Array<{ value: SupplyPurchaseStage; label: string }> = [
	{ value: 'draft', label: 'Черновик' },
	{ value: 'approval', label: 'На согласовании' },
	{ value: 'approved', label: 'Согласовано' },
	{ value: 'ordered', label: 'Заказано' },
	{ value: 'cancelled', label: 'Отменено' },
];

function DocumentDetail({ document, suppliers, busy, canDelete, onClose, onDelete, onSavePurchase, onReceivePurchase, onCreatePurchaseTransfer, onShipTransfer, onReceiveTransfer, onResolveShortage }: {
	document: OpenSupplyDocument;
	suppliers: string[];
	busy: boolean;
	canDelete: boolean;
	onClose: () => void;
	onDelete: () => void;
	onSavePurchase: (supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>, stage: SupplyPurchaseStage, expectedAt: string) => void;
	onReceivePurchase: (lines: Array<{ productId: number; qty: number; rate: number }>) => void;
	onCreatePurchaseTransfer: (lines: Array<{ productId: number; qty: number }>) => void;
	onShipTransfer: () => void;
	onReceiveTransfer: (lines: Array<{ productId: number; qty: number }>) => void;
	onResolveShortage: () => void;
}): JSX.Element {
	const purchase = document.kind === 'purchase' ? document.purchase : null;
	const initialTransfer = document.kind === 'transfer' ? document.transfer : null;
	const [supplier, setSupplier] = useState(purchase?.supplier ?? '');
	const [purchaseStage, setPurchaseStage] = useState<SupplyPurchaseStage>((purchase?.supplyStage as SupplyPurchaseStage | undefined) ?? 'draft');
	const [expectedAt, setExpectedAt] = useState(purchase?.expectedAt ?? '');
	const [purchaseLines, setPurchaseLines] = useState(() => (purchase?.lines ?? []).map((line, index) => ({
		key: `${line.productId}:${index}`,
		productId: line.productId,
		itemName: line.name || `#${line.productId}`,
		qty: Number(line.qty || 0),
		rate: Number(line.rate || 0) > 0.01 ? Number(line.rate) : 0,
	})));
	const [receiveLines, setReceiveLines] = useState<Record<string, number>>(() => Object.fromEntries((initialTransfer?.lines ?? []).map((line) => [String(line.productId), line.qty])));
	const [purchaseReceiveLines, setPurchaseReceiveLines] = useState<Record<string, number>>(() => {
		if (!purchase) return {};
		const received = new Map<number, number>();
		for (const receipt of purchase.receipts) for (const line of receipt.lines) received.set(line.productId, (received.get(line.productId) ?? 0) + Number(line.qty || 0));
		return Object.fromEntries(purchase.lines.map((line) => [String(line.productId), Math.max(Number(line.qty || 0) - (received.get(line.productId) ?? 0), 0)]));
	});
	const [purchaseTransferLines, setPurchaseTransferLines] = useState<Record<string, number>>(() => {
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

	if (document.kind === 'purchase') {
		const { order, purchase: currentPurchase } = document;
		const status = purchaseStatus(currentPurchase);
		const total = purchaseLines.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.rate || 0), 0);
		const receivedByProduct = new Map<number, number>();
		for (const receipt of currentPurchase.receipts) for (const line of receipt.lines) receivedByProduct.set(line.productId, (receivedByProduct.get(line.productId) ?? 0) + Number(line.qty || 0));
		const canReceivePurchase = currentPurchase.supplyStage === 'ordered' && purchaseLines.some((line) => Math.max(line.qty - (receivedByProduct.get(line.productId) ?? 0), 0) > 0);
		const transferAvailable = purchaseTransferAvailable(order, currentPurchase);
		const canCreatePurchaseTransfer = [...transferAvailable.values()].some((qty) => qty > 0);
		const receivePurchasePayload = purchaseLines.map((line) => ({
			productId: line.productId,
			qty: Math.max(0, Math.min(Number(purchaseReceiveLines[String(line.productId)] ?? 0), Math.max(line.qty - (receivedByProduct.get(line.productId) ?? 0), 0))),
			rate: line.rate,
		})).filter((line) => line.qty > 0);
		const purchaseTransferPayload = purchaseLines.map((line) => ({
			productId: line.productId,
			qty: Math.max(0, Math.min(Number(purchaseTransferLines[String(line.productId)] ?? 0), transferAvailable.get(line.productId) ?? 0)),
		})).filter((line) => line.qty > 0);
		return (
			<div className="supply-proto-overlay">
				<section className="supply-proto-modal supply-document-modal" role="dialog" aria-modal="true" aria-label={`Заявка поставщику ${currentPurchase.name}`}>
					<header>
						<div><span className="supply-document-eyebrow">Заявка поставщику</span><h2>{currentPurchase.name}</h2><p>{order.name} · сделка #{order.dealId}</p></div>
						<div className="supply-document-modal-head"><span>{status.label}</span><button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button></div>
					</header>
					<dl className="supply-document-facts">
						<div><dt>Поставщик</dt><dd><input list="supply-document-suppliers" value={supplier} onChange={(e) => setSupplier(e.target.value)} /></dd></div>
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
									<td><input type="number" min="0" step="any" value={line.qty} onChange={(e) => setPurchaseLines((current) => current.map((row) => row.key === line.key ? { ...row, qty: Number(e.target.value) } : row))} /></td>
									<td><input type="number" min="0" step="any" value={line.rate} onChange={(e) => setPurchaseLines((current) => current.map((row) => row.key === line.key ? { ...row, rate: Number(e.target.value) } : row))} /></td>
									<td>{line.rate > 0 ? `${money(line.rate * line.qty)} ₽` : '—'}</td>
									{canReceivePurchase && <td><input type="number" min="0" max={Math.max(line.qty - (receivedByProduct.get(line.productId) ?? 0), 0)} step="any" value={purchaseReceiveLines[String(line.productId)] ?? 0} onChange={(e) => setPurchaseReceiveLines((current) => ({ ...current, [String(line.productId)]: Math.max(0, Math.min(Math.max(line.qty - (receivedByProduct.get(line.productId) ?? 0), 0), Number(e.target.value) || 0)) }))} /><small>осталось {Math.max(line.qty - (receivedByProduct.get(line.productId) ?? 0), 0)}</small></td>}
									{canCreatePurchaseTransfer && <td>{transferMax > 0 ? <input type="number" min="0" max={transferMax} step="any" value={purchaseTransferLines[String(line.productId)] ?? 0} onChange={(e) => setPurchaseTransferLines((current) => ({ ...current, [String(line.productId)]: Math.max(0, Math.min(transferMax, Number(e.target.value) || 0)) }))} /> : '—'}</td>}
									<td>{purchaseLines.length > 1 && <button className="supply-document-remove-line" type="button" title="Удалить позицию" aria-label="Удалить позицию" onClick={() => setPurchaseLines((current) => current.filter((row) => row.key !== line.key))}>×</button>}</td>
								</tr>;
							})}
						</tbody></table>
					</div>
					{currentPurchase.receipts.length > 0 && <section className="supply-document-receipts"><h3>Оприходования</h3>{currentPurchase.receipts.map((receipt) => <div key={receipt.name}><b>{receipt.name}</b><span>{documentAmount(receipt.lines)}</span><small>{receipt.lines.map(lineTitle).join(' · ')}</small></div>)}</section>}
					<datalist id="supply-document-suppliers">{suppliers.map((name) => <option key={name} value={name} />)}</datalist>
					<footer className="supply-document-modal-footer">
						<div>{canDelete && <button className="danger" type="button" disabled={busy} onClick={onDelete}>Удалить</button>}<select value={purchaseStage} onChange={(e) => setPurchaseStage(e.target.value as SupplyPurchaseStage)}>{PURCHASE_STAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
						<div>{canCreatePurchaseTransfer && <button type="button" disabled={busy || !purchaseTransferPayload.length} title={`Создать перемещение на ${order.toStore}`} onClick={() => onCreatePurchaseTransfer(purchaseTransferPayload)}>{busy ? 'Провожу...' : 'Создать перемещение'}</button>}{canReceivePurchase && <button type="button" disabled={busy || !receivePurchasePayload.length} title="Оприходовать фактически полученное на Склад Прихода" onClick={() => onReceivePurchase(receivePurchasePayload)}>{busy ? 'Провожу...' : 'Оприходовать'}</button>}<button type="button" onClick={onClose}>Закрыть</button><button className="primary" type="button" disabled={busy || !supplier.trim() || !purchaseLines.some((line) => line.qty > 0)} onClick={() => onSavePurchase(supplier.trim(), purchaseLines.filter((line) => line.qty > 0).map(({ productId, itemName, qty, rate }) => ({ productId, itemName, qty, rate })), purchaseStage, expectedAt)}>{busy ? 'Сохраняю...' : 'Сохранить'}</button></div>
					</footer>
				</section>
			</div>
		);
	}

	const { order, transfer } = document;
	const status = transferStatus(transfer);
	const receivedByProduct = new Map(transfer.receivedLines.map((line) => [line.productId, line.qty]));
	const shortageByProduct = new Map(transfer.shortageLines.map((line) => [line.productId, line.qty]));
	return (
		<div className="supply-proto-overlay">
			<section className="supply-proto-modal supply-document-modal" role="dialog" aria-modal="true" aria-label={transfer.name || `Перемещение #${transfer.id}`}>
				<header>
					<div><span className="supply-document-eyebrow">Перемещение</span><h2>{transfer.name || `#${transfer.id}`}</h2><p>{order.name} · сделка #{order.dealId}</p></div>
					<div className="supply-document-modal-head"><span>{status.label}</span><button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button></div>
				</header>
				<dl className="supply-document-facts">
					<div><dt>Откуда</dt><dd>{transfer.fromStore}</dd></div>
					<div><dt>Куда</dt><dd>{transfer.toStore}</dd></div>
					<div><dt>Позиций</dt><dd>{transfer.lines.length}</dd></div>
					<div><dt>Количество</dt><dd>{transfer.lines.reduce((sum, line) => sum + line.qty, 0)}</dd></div>
				</dl>
				<div className="supply-document-lines">
					<table><thead><tr><th>Позиция</th><th>Отправлено</th><th>Получено</th><th>Недовоз</th></tr></thead><tbody>
						{transfer.lines.map((line, index) => <tr key={`${line.productId}-${index}`}><td><b>{line.name || `#${line.productId}`}</b><small>#{line.productId}</small></td><td>{line.qty}</td><td>{transfer.status === 'in_transit' ? <input type="number" min="0" max={line.qty} step="any" value={receiveLines[String(line.productId)] ?? 0} onChange={(e) => setReceiveLines((current) => ({ ...current, [String(line.productId)]: Math.max(0, Math.min(line.qty, Number(e.target.value) || 0)) }))} /> : (receivedByProduct.get(line.productId) ?? '—')}</td><td>{shortageByProduct.get(line.productId) ?? '—'}</td></tr>)}
					</tbody></table>
				</div>
				<footer className="supply-document-modal-footer">
					<div>{canDelete && <button className="danger" type="button" disabled={busy} onClick={onDelete}>Удалить</button>}</div>
					<div>
						<button type="button" onClick={onClose}>Закрыть</button>
						{transfer.status === 'requested' && <button className="primary" type="button" disabled={busy} onClick={onShipTransfer}>{busy ? 'Провожу...' : 'В путь'}</button>}
						{transfer.status === 'in_transit' && <button className="primary" type="button" disabled={busy} onClick={() => onReceiveTransfer(transfer.lines.map((line) => ({ productId: line.productId, qty: Number(receiveLines[String(line.productId)] ?? 0) })))}>{busy ? 'Провожу...' : 'Подтвердить приём'}</button>}
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
	onPatch,
	onAdd,
	onRemove,
}: {
	order: SupplyOrderRow;
	item: SupplyOrderItem;
	index: number;
	decisions: DecisionState[];
	suppliers: string[];
	onPatch: (id: string, patch: Partial<DecisionState>) => void;
	onAdd: () => void;
	onRemove: (id: string) => void;
}): JSX.Element {
	const entries = stockEntries(item);
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
								<>
									<input list={`suppliers-${order.name}-${index}-${allocationIndex}`} value={decision.supplier} onChange={(e) => onPatch(decision.id, { supplier: e.target.value })} placeholder="поставщик" />
									<datalist id={`suppliers-${order.name}-${index}-${allocationIndex}`}>
										{suppliers.map((supplier) => <option key={supplier} value={supplier} />)}
									</datalist>
								</>
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

function OrdersView({
	orders,
	sort,
	expanded,
	decisions,
	suppliers,
	busy,
	reviewing,
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
}: {
	orders: SupplyOrderRow[];
	sort: SortKey;
	expanded: string;
	decisions: DecisionMap;
	suppliers: string[];
	busy: string | null;
	reviewing: string;
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
				{orders.length === 0 && <div className="empty">Заявок пока нет.</div>}
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
						return count + (transferTotal > item.qty ? 1 : 0) + storeErrors;
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
									<small>#{order.dealId} · {order.toStore || 'склад не указан'} · {order.date || 'без даты'}</small>
								</div>
								<div className="supply-order-head-meta">
									<Pill tone={requestState.tone}>{requestState.label}</Pill>
									{documentsSummary(order)}
								</div>
							</button>
							{isOpen && (
								<div className="supply-order-body">
									<div className="supply-proto-table-wrap">
										<table className="supply-proto-table supply-decision-table">
											<thead><tr><th>Позиция</th><th>Нужно</th><th>Остатки</th><th>Действие</th><th>Откуда / поставщик</th><th>Кол-во</th></tr></thead>
											<tbody>
											{items.length === 0 ? <tr><td colSpan={6} className="empty">{order.closed ? 'Заявка выполнена.' : 'Все позиции распределены. Ожидается исполнение документов.'}</td></tr> : items.map((item, index) => {
													const key = rowKey(order.name, item.productId, index);
													const rowDecisions = decisionsForRow(decisions, key, item.qty);
													const assigned = rowDecisions.filter(decisionReady).reduce((sum, decision) => sum + decision.qty, 0);
													return <DecisionRows key={key} order={order} item={item} index={index} decisions={rowDecisions} suppliers={suppliers} onPatch={(id, patch) => onPatch(key, id, patch)} onAdd={() => onAdd(key, Math.max(item.qty - assigned, 1))} onRemove={(id) => onRemove(key, id)} />;
												})}
											</tbody>
										</table>
									</div>
								<div className="supply-order-docs">
									{(order.transfers?.length ?? 0) === 0 && (order.purchases?.length ?? 0) === 0
										? <p className="muted">Документов нет.</p>
										: <div className="supply-document-tree">
											{(order.transfers ?? []).map((transfer) => {
												const status = transferStatus(transfer);
												return (
													<div key={`t-${transfer.id}`} className="supply-document-branch">
														<button className="supply-document-row" type="button" onClick={() => onOpenTransfer(order, transfer)}>
															<div><span className="kind">Перемещение</span><b>{transfer.fromStore} → {transfer.toStore}</b><small>{transfer.name || `#${transfer.id}`}</small></div>
															<div className="supply-document-meta"><span>{documentAmount(transfer.lines)}</span><span className="status">{status.label}</span></div>
														</button>
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
													<span className="supply-review-status">В пути</span>
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
									<div key={`${order.name}-${transfer.id}`} className="supply-proto-node">
									<div className="node-top">
										<div><span className="kind">перемещение</span> <button className="supply-inline-document-link" type="button" onClick={() => onOpenTransfer(order, transfer)}>{transfer.name || `#${transfer.id}`}</button> · {transfer.fromStore || 'склад'} → {transfer.toStore || 'точка'}</div>
											<Pill tone={status.tone}>{status.label}</Pill>
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

function RegistryView({ orders, kind, onOpenPurchase, onOpenTransfer }: { orders: SupplyOrderRow[]; kind: ViewKey; onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void; onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void }): JSX.Element {
	const rows: RegistryRow[] = kind === 'purchase'
		? orders.flatMap((order) => (order.purchases ?? []).map((purchase) => ({ kind: 'purchase' as const, order, purchase })))
		: kind === 'logistics'
			? orders.flatMap((order) => (order.transfers ?? []).map((transfer) => ({ kind: 'logistics' as const, order, transfer })))
			: [];
	return (
		<section className="supply-proto-card">
			<div className="supply-proto-card-head">
				<div>
					<h2>{kind === 'purchase' ? 'Закупки' : kind === 'logistics' ? 'Логистика' : 'Остатки'}</h2>
					<p>Отдельный реестр документов без дерева.</p>
				</div>
			</div>
			{kind === 'stock' ? (
				<div className="empty">Остатки оставляем отдельным быстрым реестром. Основной сценарий здесь начинается с заявки.</div>
			) : (
				<div className="supply-proto-table-wrap">
					<table className="supply-proto-table">
						<thead><tr><th>Документ</th><th>Сделка</th><th>Маршрут / поставщик</th><th>Позиции</th><th>Статус</th></tr></thead>
						<tbody>
							{rows.length === 0 ? <tr><td colSpan={5} className="empty">Пока пусто.</td></tr> : rows.map((row) => {
								if (row.kind === 'purchase') {
									const status = purchaseStatus(row.purchase);
									return <tr key={`${row.order.name}-${row.purchase.name}`}><td><button className="supply-table-document-link" type="button" onClick={() => onOpenPurchase(row.order, row.purchase)}>{row.purchase.name}</button></td><td>#{row.order.dealId}</td><td>{row.purchase.supplier || 'поставщик не выбран'}</td><td>{row.purchase.lines.map(lineTitle).join(' · ')}</td><td><Pill tone={status.tone}>{status.label}</Pill></td></tr>;
								}
								const status = transferStatus(row.transfer);
								return <tr key={`${row.order.name}-${row.transfer.id}`}><td><button className="supply-table-document-link" type="button" onClick={() => onOpenTransfer(row.order, row.transfer)}>{row.transfer.name || `#${row.transfer.id}`}</button></td><td>#{row.order.dealId}</td><td>{row.transfer.fromStore} → {row.transfer.toStore}</td><td>{row.transfer.lines.map(lineTitle).join(' · ')}</td><td><Pill tone={status.tone}>{status.label}</Pill></td></tr>;
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

export function Supply(): JSX.Element {
	const ctx = getContext();
	const [phase, setPhase] = useState<Phase>('init');
	const [orders, setOrders] = useState<SupplyOrderRow[]>(ctx.__mock ? MOCK_ORDERS : []);
	const [suppliers, setSuppliers] = useState<string[]>(DEFAULT_SUPPLIERS);
	const [loading, setLoading] = useState(!ctx.__mock);
	const [view, setView] = useState<ViewKey>('orders');
	const [sort, setSort] = useState<SortKey>('dateDesc');
	const [expanded, setExpanded] = useState('');
	const [decisions, setDecisions] = useState<DecisionMap>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [reviewing, setReviewing] = useState('');
	const [openDocument, setOpenDocument] = useState<OpenSupplyDocument | null>(null);
	const [documentBusy, setDocumentBusy] = useState(false);
	const [currentUserId, setCurrentUserId] = useState('');
	const [notice, setNotice] = useState<string | null>(null);

	const reload = async (): Promise<void> => {
		const loaded = await fetchSupplyOrders();
		setOrders(loaded);
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
			setNotice(`${transfer.name || `Перемещение #${transfer.id}`}: товар отправлен в транзит на ${target.order.toStore}.`);
		} catch (err) {
			await refreshOpenDocument(target).catch(() => undefined);
			setNotice(err instanceof Error ? err.message : 'Не удалось создать перемещение на точку.');
		} finally { setDocumentBusy(false); }
	};

	const moveOpenTransfer = async (action: 'ship' | 'receive' | 'resolve', lines: Array<{ productId: number; qty: number }> = []): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'transfer' || documentBusy) return;
		setDocumentBusy(true);
		try {
			if (action === 'ship') await shipTransfer(target.transfer.id);
			else if (action === 'receive') await receiveTransfer(target.transfer.id, lines);
			else await resolveTransferShortage(target.transfer.id);
			await refreshOpenDocument(target);
			setNotice(`${target.transfer.name || `Перемещение #${target.transfer.id}`}: статус обновлён.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось изменить статус перемещения.');
		} finally { setDocumentBusy(false); }
	};

	const deleteOpenDocument = async (): Promise<void> => {
		const target = openDocument;
		if (!target || documentBusy || currentUserId !== '1858') return;
		const title = target.kind === 'purchase' ? target.purchase.name : (target.transfer.name || `Перемещение #${target.transfer.id}`);
		const detail = target.kind === 'purchase'
			? 'Связанные оприходования будут отменены.'
			: 'Все проведённые складские движения этого перемещения будут отменены.';
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
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				setCurrentUserId(uid);
				if (!isPortalAdmin() && !BETA_USER_IDS.includes(uid)) { setPhase('denied'); return; }
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
	}, [ctx.__mock]);

	const sortedOrders = useMemo(() => [...orders].sort((a, b) => {
		if (sort === 'dateAsc') return String(a.date).localeCompare(String(b.date));
		if (sort === 'store') return String(a.toStore).localeCompare(String(b.toStore), 'ru');
		if (sort === 'deal') return String(a.dealTitle || a.dealId).localeCompare(String(b.dealTitle || b.dealId), 'ru');
		return String(b.date).localeCompare(String(a.date));
	}), [orders, sort]);

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
		try {
			const transferPlan = decisionGroups(lines, 'transfer');
			const purchasePlan = decisionGroups(lines, 'purchase');
			let createdTransferCount = transferPlan.length;
			let createdPurchaseCount = purchasePlan.length;
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
				await reload();
			}
			setDecisions((current) => {
				const next = { ...current };
				requestItemsForOrder(order).forEach((item, index) => { delete next[rowKey(order.name, item.productId, index)]; });
				return next;
			});
			setReviewing('');
			const parts = [
				createdTransferCount ? `перемещений: ${createdTransferCount} (товар в транзите)` : '',
				createdPurchaseCount ? `заявок поставщику: ${createdPurchaseCount} (черновики)` : '',
			].filter(Boolean);
			setNotice(`Готово. Создано ${parts.join(', ')}.`);
		} catch (err) {
			if (!ctx.__mock) await reload().catch(() => undefined);
			setReviewing('');
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	if (phase === 'init') return <div className="supply-proto-state">Загрузка...</div>;
	if (phase === 'denied') return <div className="supply-proto-state">Раздел «Снаб» в обкатке. Доступ ограничен.</div>;

	return (
		<div className="supply-proto-shell">
			<aside className="supply-proto-rail">
				<div className="supply-proto-brand"><span>С</span><div><b>Снаб</b><small>рабочий сценарий</small></div></div>
				<button className={view === 'orders' ? 'active' : ''} type="button" onClick={() => setView('orders')}>Обеспечение и заказы</button>
				<button className={view === 'tree' ? 'active' : ''} type="button" onClick={() => setView('tree')}>Дерево сделок</button>
				<button className={view === 'purchase' ? 'active' : ''} type="button" onClick={() => setView('purchase')}>Закупки</button>
				<button className={view === 'logistics' ? 'active' : ''} type="button" onClick={() => setView('logistics')}>Логистика</button>
				<button className={view === 'stock' ? 'active' : ''} type="button" onClick={() => setView('stock')}>Остатки</button>
				<div className="supply-proto-source">Данные: {ctx.__mock ? 'демо' : 'ядро'}<br />Документы: {ctx.__mock ? 'превью' : 'живые'}</div>
			</aside>
			<main className="supply-proto-main">
				<header className="supply-proto-top">
					<div>
						<h1>Снабжение</h1>
						<p>Заявка раскрывается в строки, снабжение вручную выбирает закупку или перемещение.</p>
					</div>
				</header>
				<Metrics orders={orders} />
				{notice && <div className="supply-proto-notice"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Закрыть</button></div>}
				{loading && <div className="supply-proto-card empty">Загрузка заявок из ядра...</div>}
				{view === 'orders' && <OrdersView orders={sortedOrders} sort={sort} expanded={expanded} decisions={decisions} suppliers={suppliers} busy={busy} reviewing={reviewing} onSort={setSort} onToggle={(name) => { setReviewing(''); setExpanded((current) => current === name ? '' : name); }} onPatch={patchDecision} onAdd={addDecision} onRemove={removeDecision} onReview={setReviewing} onCancelReview={() => setReviewing('')} onCreate={(order) => void createDocs(order)} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} />}
				{view === 'tree' && <TreeView orders={orders} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} />}
				{(view === 'purchase' || view === 'logistics' || view === 'stock') && <RegistryView orders={orders} kind={view} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} />}
			</main>
			{openDocument && <DocumentDetail
				key={openDocument.kind === 'purchase' ? `purchase-${openDocument.purchase.name}` : `transfer-${openDocument.transfer.id}`}
				document={openDocument}
				suppliers={suppliers}
				busy={documentBusy}
				canDelete={currentUserId === '1858'}
				onClose={() => setOpenDocument(null)}
				onDelete={() => void deleteOpenDocument()}
				onSavePurchase={(supplier, lines, stage, expectedAt) => void saveOpenPurchase(supplier, lines, stage, expectedAt)}
				onReceivePurchase={(lines) => void receiveOpenPurchase(lines)}
				onCreatePurchaseTransfer={(lines) => void createOpenPurchaseTransfer(lines)}
				onShipTransfer={() => void moveOpenTransfer('ship')}
				onReceiveTransfer={(lines) => void moveOpenTransfer('receive', lines)}
				onResolveShortage={() => void moveOpenTransfer('resolve')}
			/>}
		</div>
	);
}
