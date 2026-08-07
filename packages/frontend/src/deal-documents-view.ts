import type { TableData } from './deal-products-table-types.js';

export function buildDealDocumentsView(data: TableData, transferCount: number) {
	return {
		realizationDocuments: data.coreReals.filter((document) => !document.isReturn),
		returnDocuments: data.coreReals.filter((document) => document.isReturn),
		dealDocumentCount: data.contracts.length + data.coreReals.length + data.supply.length + transferCount,
	};
}
