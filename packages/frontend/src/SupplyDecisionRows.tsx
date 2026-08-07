import { type SupplyDecisionAction, type SupplyOrderItem, type SupplyOrderRow } from './b24.js';
import { decisionReady, type DecisionState } from './supply-decision-planning.js';
import { SupplyRequestLineEditor } from './SupplyRequestLineEditor.js';
import { SupplySupplierField } from './SupplySupplierField.js';

const stockEntries = (item: { stocks: Record<string, number> }): Array<[string, number]> =>
	Object.entries(item.stocks ?? {}).filter(([, qty]) => Number(qty) > 0).sort((a, b) => b[1] - a[1]);

const compactStock = (item: { stocks: Record<string, number> }): string => {
	const entries = stockEntries(item);
	if (!entries.length) return 'нет на складах';
	return entries.map(([name, qty]) => `${name}: ${qty}`).join(' · ');
};

export function SupplyDecisionRows({
	order,
	item,
	originalItem,
	index,
	decisions,
	suppliers,
	onCreateSupplier,
	onPatch,
	onAdd,
	onRemove,
	onEditLine,
}: {
	order: SupplyOrderRow;
	item: SupplyOrderItem;
	originalItem: SupplyOrderItem;
	index: number;
	decisions: DecisionState[];
	suppliers: string[];
	onCreateSupplier: (name: string) => Promise<string>;
	onPatch: (id: string, patch: Partial<DecisionState>) => void;
	onAdd: () => void;
	onRemove: (id: string) => void;
	onEditLine: () => Promise<void>;
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
									<b>{item.itemName || `#${item.productId}`}</b> <SupplyRequestLineEditor order={order} item={originalItem} onSaved={onEditLine} />
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
								<SupplySupplierField id={`suppliers-${order.name}-${index}-${allocationIndex}`} value={decision.supplier} suppliers={suppliers} onChange={(supplier) => onPatch(decision.id, { supplier })} onCreate={onCreateSupplier} />
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
