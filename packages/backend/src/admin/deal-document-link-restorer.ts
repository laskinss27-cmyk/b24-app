import type { ErpClient } from '../erp/client.js';
import { DEAL_FIELD } from '../erp/erp-setup.js';
import type { AdminDealDocument } from './deal-document-diagnostics.js';
import type { DealDocumentStructureLink } from './deal-document-structure.js';

export interface RestoreDealDocumentLinkInput {
	dealId: number;
	targetType: AdminDealDocument['type'];
	targetName: string;
	comment: string;
}

export interface RestoreDealDocumentLinkResult {
	dealId: number;
	targetType: AdminDealDocument['type'];
	targetName: string;
	changed: boolean;
}

export class DealDocumentLinkRestoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DealDocumentLinkRestoreError';
	}
}

export const RESTORABLE_DOCUMENT_TYPES = new Set<AdminDealDocument['type']>([
	'Sales Order',
	'Delivery Note',
	'Material Request',
	'Purchase Order',
	'Purchase Receipt',
	'Stock Entry',
]);

export function normalizeRestoreComment(value: unknown): string {
	const comment = typeof value === 'string' ? value.trim().slice(0, 500) : '';
	if (comment.length < 3) throw new DealDocumentLinkRestoreError('Укажите комментарий: почему восстанавливается связь документа.');
	return comment;
}

function currentDealId(document: Record<string, unknown>): number | null {
	const value = Number(document[DEAL_FIELD]);
	return Number.isInteger(value) && value > 0 ? value : null;
}

function eligibleLink(input: RestoreDealDocumentLinkInput, links: DealDocumentStructureLink[]): DealDocumentStructureLink | undefined {
	return links.find((link) =>
		link.targetType === input.targetType
		&& link.targetName === input.targetName
		&& link.status === 'wrong_deal'
		&& link.targetDealId === null
		&& link.targetDocstatus === 0);
}

export async function restoreUnlinkedDealDocument(
	erp: ErpClient,
	input: RestoreDealDocumentLinkInput,
	verifiedLinks: DealDocumentStructureLink[],
): Promise<RestoreDealDocumentLinkResult> {
	if (!Number.isInteger(input.dealId) || input.dealId <= 0) throw new DealDocumentLinkRestoreError('Некорректный ID сделки.');
	if (!RESTORABLE_DOCUMENT_TYPES.has(input.targetType)) throw new DealDocumentLinkRestoreError('Этот тип документа нельзя перепривязать через админку.');
	const targetName = input.targetName.trim().slice(0, 160);
	if (!targetName) throw new DealDocumentLinkRestoreError('Не указан документ для восстановления связи.');
	normalizeRestoreComment(input.comment);
	const normalized = { ...input, targetName };
	if (!eligibleLink(normalized, verifiedLinks)) {
		throw new DealDocumentLinkRestoreError('Связь больше не соответствует безопасным условиям. Обновите диагностику и проверьте документ вручную.');
	}

	const before = await erp.get<Record<string, unknown>>(normalized.targetType, normalized.targetName);
	if (!before) throw new DealDocumentLinkRestoreError('Документ больше не существует в ядре.');
	const linkedDealId = currentDealId(before);
	if (linkedDealId === normalized.dealId) return { dealId: normalized.dealId, targetType: normalized.targetType, targetName: normalized.targetName, changed: false };
	if (linkedDealId !== null) throw new DealDocumentLinkRestoreError(`Документ уже привязан к другой сделке #${linkedDealId}.`);
	if (Number(before['docstatus']) !== 0) throw new DealDocumentLinkRestoreError('Автоматически восстанавливать связь можно только у черновика.');

	await erp.update(normalized.targetType, normalized.targetName, { [DEAL_FIELD]: String(normalized.dealId) });
	const after = await erp.get<Record<string, unknown>>(normalized.targetType, normalized.targetName);
	if (!after || currentDealId(after) !== normalized.dealId) {
		throw new Error('Ядро не подтвердило восстановленную связь документа со сделкой.');
	}
	return { dealId: normalized.dealId, targetType: normalized.targetType, targetName: normalized.targetName, changed: true };
}
