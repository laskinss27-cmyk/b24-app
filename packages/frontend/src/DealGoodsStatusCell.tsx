import type { StoreInfo, SupplyCard, TransferDoc } from './b24.js';
import {stockChoiceLabel} from '@b24-app/shared';
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
					title="Состояние и склад остатка, который будет списан при отгрузке"
					aria-label="Состояние и склад для продажи"
				>
					{stores.map((store) => (
						<option key={store.id} value={store.id}>{stockChoiceLabel(store.title,storeAmount(store.id))}</option>
					))}
				</select>
				{activeTransfer ? (
					<span className={`st-badge ${activeTransfer.status === 'in_transit' ? 'transit' : 'requested'}`} title={`${activeTransfer.fromStore} → ${activeTransfer.toStore}`}>
						{activeTransferLabel}
					</span>
				) : status === 'ready' ? <span className="st-badge ready">✓ хватит</span> : (
					<span className={`st-badge ${status === 'order' ? 'order' : 'requested'}`}>{activeSupply ? 'заказано' : status === 'order' ? 'нужен заказ' : 'нужно привезти'}</span>
				)}
				{!activeTransfer && status !== 'ready' && receivedTransfer && (
					<button
						className="st-badge requested"
						disabled={refreshing || busy}
						onClick={onRefresh}
						title="Ранее товар привозили — проверить текущий остаток"
					>{refreshing ? '…' : 'Обновить остаток'}</button>
				)}
			</>}
		</td>
	);
}
