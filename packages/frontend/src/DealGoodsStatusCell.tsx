import type { StoreInfo, SupplyCard, TransferDoc } from './b24.js';
import { stageLabel } from './deal-display-formatters.js';
import type { DealProductAvailabilityStatus } from './deal-product-availability.js';

export function DealGoodsStatusCell({
	workingMode,
	alternativeView,
	stores,
	selectedStoreId,
	storeAmount,
	selectionDisabled,
	activeTransfer,
	activeTransferLabel,
	receivedTransfer,
	status,
	activeSupply,
	refreshing,
	busy,
	onStoreChange,
	onRefresh,
}: {
	workingMode: boolean;
	alternativeView: boolean;
	stores: StoreInfo[];
	selectedStoreId: number;
	storeAmount: (storeId: number) => number;
	selectionDisabled: boolean;
	activeTransfer: TransferDoc | null;
	activeTransferLabel: string | null;
	receivedTransfer: boolean;
	status: DealProductAvailabilityStatus;
	activeSupply: SupplyCard | null;
	refreshing: boolean;
	busy: boolean;
	onStoreChange: (storeId: number) => void;
	onRefresh: () => void;
}): JSX.Element {
	return (
		<td className="realize-cell">
			{!workingMode ? <span className="st-badge proposal">{alternativeView ? 'альтернатива' : 'расчёт'}</span> : <>
				<select
					className="store-select" value={selectedStoreId} disabled={selectionDisabled}
					onChange={(event) => onStoreChange(Number(event.target.value))}
					title="Склад, с которого отгружаем эту строку"
				>
					{stores.map((store) => (
						<option key={store.id} value={store.id}>{store.title} ({storeAmount(store.id)})</option>
					))}
				</select>
				{activeTransfer ? (
					<span className={`st-badge ${activeTransfer.status === 'in_transit' ? 'transit' : 'requested'}`} title={`${activeTransfer.fromStore} → ${activeTransfer.toStore}`}>
						{activeTransferLabel}
					</span>
				) : status === 'ready' ? <span className="st-badge ready">✓ хватит</span> : receivedTransfer ? (
					<button
						className="st-badge ready"
						disabled={refreshing || busy}
						onClick={onRefresh}
						title="Перемещение получено — обновить остаток из ядра, чтобы реализовать"
					>{refreshing ? '…' : '✓ принято — обновить'}</button>
				) : null}
				{!activeTransfer && !receivedTransfer && status === 'order' && (
					activeSupply
						? <span className="st-badge order" title={`${activeSupply.title} · ${stageLabel(activeSupply.stageId)}`}>заказано</span>
						: <span className="st-badge order" title="Нет нигде — отметь строку галочкой и нажми «Заказать»">нужен заказ</span>
				)}
			</>}
		</td>
	);
}
