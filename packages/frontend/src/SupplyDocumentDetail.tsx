import { useEffect, useState } from 'react';
import {
	fetchStockFormData,
	type SupplyOrderRow,
	type SupplyPurchaseChild,
	type SupplyPurchaseStage,
	type SupplyTransferChild,
} from './b24.js';
import {
	documentAmount,
	lineTitle,
	money,
	purchaseTransferAvailable,
	sameStore,
	transferDocumentLabel,
	transferHasDiscrepancy,
	transferHistoryLabel,
	transferStatus,
} from './supply-document-values.js';
import { purchaseStatus } from './supply-purchase-status.js';
import { SupplyPurchasePrint } from './SupplyPrintViews.js';
import { SupplySupplierField } from './SupplySupplierField.js';

export type OpenSupplyDocument =
	| { kind: 'purchase'; order: SupplyOrderRow; purchase: SupplyPurchaseChild }
	| { kind: 'transfer'; order: SupplyOrderRow; transfer: SupplyTransferChild };

export type NumericDraft = number | '';
type PurchaseDraftRow = { key: string; productId: number; itemName: string; qty: NumericDraft; rate: NumericDraft };
export const numericDraft = (value: string): NumericDraft => value === '' ? '' : Number(value);

export const PURCHASE_STAGE_OPTIONS: Array<{ value: SupplyPurchaseStage; label: string }> = [
	{ value: 'draft', label: 'Черновик' },
	{ value: 'approval', label: 'На согласовании' },
	{ value: 'approved', label: 'Согласовано' },
	{ value: 'ordered', label: 'Заказано' },
	{ value: 'cancelled', label: 'Отменено' },
];

export function SupplyDocumentDetail({ document, suppliers, busy, canDelete, onClose, onDelete, onCreateSupplier, onSavePurchase, onReceivePurchase, onCreatePurchaseTransfer, onChangeTransferDestination, onUpdateTransfer, onCollectTransfer, onShipTransfer, onReceiveTransfer, onPostTransfer, onCancelTransfer, onResolveShortage }: {
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
		const directDeliveryQty = currentPurchase.receipts.reduce((sum, receipt) =>
			sum + (receipt.docstatus === 1 ? receipt.lines : [])
				.filter((line) => sameStore(line.warehouse, order.toStore))
				.reduce((subtotal, line) => subtotal + Number(line.qty || 0), 0),
		0);
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
						<div><span className="supply-document-eyebrow">Заявка поставщику</span><h2>{currentPurchase.displayTitle || currentPurchase.name}</h2><p>{currentPurchase.displayTitle ? `${currentPurchase.name} · ${order.name}` : order.standalone ? 'Самостоятельная закупка' : `${order.name} · сделка #${order.dealId}`}</p></div>
						<div className="supply-document-modal-head"><span>{status.label}</span><button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button></div>
					</header>
					<dl className="supply-document-facts">
						<div><dt>Поставщик</dt><dd><SupplySupplierField id="supply-document-supplier" value={supplier} suppliers={suppliers} onChange={setSupplier} onCreate={onCreateSupplier} /></dd></div>
						<div><dt>Склад заявки</dt><dd>{order.toStore || 'Не указан'}</dd></div>
						<div><dt>Ожидаем</dt><dd><input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} /></dd></div>
						<div><dt>Сумма</dt><dd>{total > 0.01 ? `${money(total)} ₽` : '—'}</dd></div>
					</dl>
					{directDeliveryQty > 0 && (
						<div className="supply-direct-delivery">
							<strong>Доставлено напрямую на склад назначения</strong>
							<span>Принято: {directDeliveryQty}. Для этого количества перемещение не требуется.</span>
						</div>
					)}
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
					<div><span className="supply-document-eyebrow">Перемещение</span><h2>{transfer.displayTitle || transferDocumentLabel(transfer)}</h2><p>{transferDocumentLabel(transfer)} · {transfer.fromStore} → {transfer.toStore}{order.standalone ? ' · без сделки' : ` · сделка #${order.dealId}`}</p></div>
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
