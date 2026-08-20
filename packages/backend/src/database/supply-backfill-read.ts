import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { TRANSFERS_ENTITY } from '../b24/placement.js';
import type { ErpClient } from '../erp/client.js';
import { DEAL_FIELD } from '../erp/erp-setup.js';
import {
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_REQUEST_FIELD,
} from '../erp/stock-transfers.js';

export const TRANSFER_DOCUMENT_FIELD = 'b24_transfer_document';
export const TRANSFER_PHASE_FIELD = 'b24_transfer_phase';

export interface SupplyBackfillRawSources {
	materialRequests: Record<string, unknown>[];
	purchaseOrders: Record<string, unknown>[];
	purchaseReceipts: Record<string, unknown>[];
	stockEntries: Record<string, unknown>[];
	transferItems: Record<string, unknown>[];
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(values.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < values.length) {
			const index = cursor++;
			results[index] = await fn(values[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
	return results;
}

async function readFullDocuments(
	erp: ErpClient,
	doctype: string,
	fields: string[],
	filters: unknown[],
): Promise<Record<string, unknown>[]> {
	const heads = await erp.list<Record<string, unknown>>(doctype, fields, filters, 0, 'creation asc');
	return mapConcurrent(heads, 8, async (head) => {
		const name = String(head['name'] ?? '').trim();
		if (!name) throw new Error(`${doctype}: list returned a row without name`);
		const full = await erp.get<Record<string, unknown>>(doctype, name);
		if (!full) throw new Error(`${doctype} ${name}: disappeared during snapshot`);
		return full;
	});
}

/** Read-only source collection. It deliberately never calls any ensure/setup helper. */
export async function readSupplyBackfillErpSources(erp: ErpClient): Promise<Omit<SupplyBackfillRawSources, 'transferItems'>> {
	// Keep the production read load bounded: at most eight child-document GETs,
	// and only one doctype scan, are active at a time.
	const materialRequests = await readFullDocuments(erp, 'Material Request', ['name', DEAL_FIELD], [[DEAL_FIELD, '!=', '']]);
	const purchaseOrders = await readFullDocuments(erp, 'Purchase Order', ['name', SUPPLY_REQUEST_FIELD], [[SUPPLY_REQUEST_FIELD, '!=', '']]);
	const purchaseReceipts = await readFullDocuments(erp, 'Purchase Receipt', ['name', SUPPLY_REQUEST_FIELD], [[SUPPLY_REQUEST_FIELD, '!=', '']]);
	const stockEntries = await readFullDocuments(erp, 'Stock Entry', ['name', TRANSFER_DOCUMENT_FIELD], [[TRANSFER_DOCUMENT_FIELD, '!=', '']]);
	return { materialRequests, purchaseOrders, purchaseReceipts, stockEntries };
}

export async function readSupplyBackfillTransferSource(client: B24Client): Promise<Record<string, unknown>[]> {
	return listAllEntityItems(client, TRANSFERS_ENTITY, { ID: 'ASC' });
}

export async function readSupplyBackfillSources(erp: ErpClient, client: B24Client): Promise<SupplyBackfillRawSources> {
	const [erpSources, transferItems] = await Promise.all([
		readSupplyBackfillErpSources(erp),
		readSupplyBackfillTransferSource(client),
	]);
	return { ...erpSources, transferItems };
}
