import { ContractModal } from './ContractModal.js';
import { ReturnModal } from './ReturnModal.js';
import { TransferSplitModal } from './TransferSplitModal.js';
import { buildDealReturnableProducts } from './deal-returnable-products.js';
import { buildDealTransferSplitSources } from './deal-transfer-split-view.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';

export function DealOperationalDialogs({
	workingMode,
	dealId,
	splitRow,
	showReturn,
	showContract,
	stores,
	goods,
	documents,
	storeOf,
	remaining,
	storeName,
	onCloseTransfer,
	onTransferDone,
	onCloseReturn,
	onReturnDone,
	onCloseContract,
	onContractDone,
}: {
	workingMode: boolean;
	dealId: number | null;
	splitRow: EnrichedRow | null;
	showReturn: boolean;
	showContract: boolean;
	stores: TableData['stores'];
	goods: EnrichedRow[];
	documents: TableData['coreReals'];
	storeOf: (row: EnrichedRow) => number;
	remaining: (row: EnrichedRow) => number;
	storeName: (storeId: number) => string;
	onCloseTransfer: () => void;
	onTransferDone: (message: string) => Promise<void>;
	onCloseReturn: () => void;
	onReturnDone: (message: string) => Promise<void>;
	onCloseContract: () => void;
	onContractDone: (message: string) => Promise<void>;
}): JSX.Element {
	return <>
		{workingMode && splitRow && dealId != null && (() => {
			const destinationStoreId = storeOf(splitRow);
			const sources = buildDealTransferSplitSources(splitRow, destinationStoreId);
			return <TransferSplitModal
				dealId={dealId}
				productId={splitRow.productId}
				name={splitRow.name}
				need={remaining(splitRow)}
				destName={storeName(destinationStoreId)}
				sources={sources}
				onClose={onCloseTransfer}
				onDone={onTransferDone}
			/>;
		})()}

		{workingMode && showReturn && dealId != null && (
			<ReturnModal
				dealId={dealId}
				stores={stores}
				returnable={buildDealReturnableProducts(goods, documents)}
				onClose={onCloseReturn}
				onDone={onReturnDone}
			/>
		)}

		{workingMode && showContract && dealId != null && (
			<ContractModal
				dealId={dealId}
				onClose={onCloseContract}
				onDone={onContractDone}
			/>
		)}
	</>;
}
