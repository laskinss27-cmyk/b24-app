import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { SUPPLY_TYPE_ID } from '../deal-supply-cards.js';
import { listDealContractDocumentsReadOnly } from '../deal-contract-storage.js';
import { TRANSFERS_ENTITY } from '../b24/placement.js';
import { parseTransferItem, type StoredTransfer } from '../transfers/model.js';

export interface AdminDealContractDocument {
	id: string;
	contractNumber: string;
	templateTitle: string;
	companyName: string;
	customerName: string;
	contractDate: string;
	createdAt: string;
	filename: string;
	total: number;
}

export interface AdminDealSupplyCard {
	id: number;
	title: string;
	stageId: string;
}

export interface AdminDealTransferDocument {
	id: number;
	name: string;
	status: string;
	fromStore: string;
	toStore: string;
	createdAt: string;
	createdByName: string;
	supplyRequest: string;
	supplyRequestKey: string;
	purchaseOrder: string;
	shipEntry: string;
	receiveEntry: string;
	note: string;
	items: Array<{ productId: number; itemName: string; qty: number }>;
	historyCount: number;
}

export interface AdminDealApplicationDocuments {
	contracts: AdminDealContractDocument[];
	supplyCards: AdminDealSupplyCard[];
	transfers: AdminDealTransferDocument[];
	errors: Array<{ source: 'contracts' | 'supply' | 'transfers'; message: string }>;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function readDealApplicationDocuments(
	client: B24Client,
	dealId: number,
	transferReader?: () => Promise<StoredTransfer[]>,
): Promise<AdminDealApplicationDocuments> {
	const [contractsResult, supplyResult, transfersResult] = await Promise.allSettled([
		listDealContractDocumentsReadOnly(dealId),
		client.call<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
			entityTypeId: SUPPLY_TYPE_ID,
			filter: { parentId2: dealId },
			select: ['id', 'title', 'stageId'],
			order: { id: 'desc' },
		}),
		transferReader
			? transferReader()
			: listAllEntityItems(client, TRANSFERS_ENTITY).then((items) => items.map(parseTransferItem).filter((item): item is StoredTransfer => item != null)),
	]);
	const errors: AdminDealApplicationDocuments['errors'] = [];
	if (contractsResult.status === 'rejected') errors.push({ source: 'contracts', message: message(contractsResult.reason) });
	if (supplyResult.status === 'rejected') errors.push({ source: 'supply', message: message(supplyResult.reason) });
	if (transfersResult.status === 'rejected') errors.push({ source: 'transfers', message: message(transfersResult.reason) });
	const contracts = contractsResult.status === 'fulfilled' ? contractsResult.value.map((document) => ({
		id: document.id,
		contractNumber: document.contractNumber,
		templateTitle: document.templateTitle,
		companyName: document.companyName,
		customerName: document.customerName,
		contractDate: document.contractDate,
		createdAt: document.createdAt,
		filename: document.filename,
		total: document.total,
	})) : [];
	const supplyCards = supplyResult.status === 'fulfilled' ? (supplyResult.value.items ?? []).map((item) => ({
		id: Number(item['id']),
		title: String(item['title'] ?? ''),
		stageId: String(item['stageId'] ?? ''),
	})).filter((item) => Number.isInteger(item.id) && item.id > 0) : [];
	const transfers = transfersResult.status === 'fulfilled' ? transfersResult.value
		.filter((item) => item.dealId === String(dealId))
		.map((item) => ({
			id: item.id,
			name: item.name,
			status: item.status,
			fromStore: item.fromStore,
			toStore: item.toStore,
			createdAt: item.createdAt,
			createdByName: item.createdByName,
			supplyRequest: item.supplyRequest,
			supplyRequestKey: item.supplyRequestKey,
			purchaseOrder: item.purchaseOrder,
			shipEntry: item.shipEntry ?? '',
			receiveEntry: item.receiveEntry ?? '',
			note: item.note,
			items: item.lines.map((line) => ({ productId: line.productId, itemName: line.name, qty: line.qty })),
			historyCount: item.history.length,
		})) : [];
	return { contracts, supplyCards, transfers, errors };
}
