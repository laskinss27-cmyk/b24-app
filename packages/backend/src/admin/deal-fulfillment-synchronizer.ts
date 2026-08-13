import type { B24Client } from '../b24/client.js';
import { calculateDealFulfillment, DEAL_FULFILLMENT_FIELD, type DealFulfillmentValue } from '../deal-fulfillment.js';
import type { ErpClient } from '../erp/client.js';
import { listDealPlan, listDealRealizations } from '../erp/operations.js';
import type { AdminDealDocumentDiagnostic } from './deal-document-diagnostics.js';

export interface SyncAdminDealFulfillmentInput {
	dealId: number;
	expectedCurrent: DealFulfillmentValue;
	expectedValue: DealFulfillmentValue;
	comment: string;
}

interface FulfillmentSnapshot {
	current: string;
	value: DealFulfillmentValue;
}

type SnapshotReader = (client: B24Client, erp: ErpClient, dealId: number) => Promise<FulfillmentSnapshot>;

export class AdminDealFulfillmentSyncError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AdminDealFulfillmentSyncError';
	}
}

export function normalizeFulfillmentSyncComment(value: unknown): string {
	const comment = typeof value === 'string' ? value.trim().slice(0, 500) : '';
	if (comment.length < 3) throw new AdminDealFulfillmentSyncError('Укажите комментарий: почему синхронизируется техническое поле сделки.');
	return comment;
}

export function fulfillmentSyncBlocker(diagnostic: AdminDealDocumentDiagnostic): string | null {
	if (diagnostic.deal.found !== true) return 'Карточка сделки Битрикс24 не прочитана.';
	if (diagnostic.deal.fulfillmentField !== 'ДА' && diagnostic.deal.fulfillmentField !== 'НЕТ') return 'В техническом поле сделки записано неизвестное значение.';
	if (diagnostic.deal.fulfillmentField === diagnostic.calculatedFulfillment) return 'Техническое поле уже совпадает с расчётом ядра.';
	const blockers = new Set(['deal_read_error', 'missing_plan', 'multiple_plans']);
	if (diagnostic.issues.some((issue) => blockers.has(issue.code))) return 'Структура плана сделки неоднозначна. Сначала устраните проблему с планом.';
	return null;
}

async function readSnapshot(client: B24Client, erp: ErpClient, dealId: number): Promise<FulfillmentSnapshot> {
	const [plan, realizations, deal] = await Promise.all([
		listDealPlan(erp, dealId),
		listDealRealizations(erp, dealId),
		client.call<Record<string, unknown>>('crm.deal.get', { id: dealId }),
	]);
	return {
		current: String(deal[DEAL_FULFILLMENT_FIELD] ?? '').trim().toLocaleUpperCase('ru-RU'),
		value: calculateDealFulfillment(plan, realizations),
	};
}

export async function synchronizeAdminDealFulfillment(
	client: B24Client,
	erp: ErpClient,
	input: SyncAdminDealFulfillmentInput,
	diagnostic: AdminDealDocumentDiagnostic,
	read: SnapshotReader = readSnapshot,
): Promise<{ previous: DealFulfillmentValue; value: DealFulfillmentValue; changed: boolean }> {
	if (!Number.isInteger(input.dealId) || input.dealId <= 0) throw new AdminDealFulfillmentSyncError('Некорректный ID сделки.');
	normalizeFulfillmentSyncComment(input.comment);
	const blocker = fulfillmentSyncBlocker(diagnostic);
	if (blocker) throw new AdminDealFulfillmentSyncError(blocker);
	if (diagnostic.deal.fulfillmentField !== input.expectedCurrent || diagnostic.calculatedFulfillment !== input.expectedValue) {
		throw new AdminDealFulfillmentSyncError('Диагностика сделки изменилась. Обновите её перед синхронизацией.');
	}

	const snapshot = await read(client, erp, input.dealId);
	if (snapshot.current !== input.expectedCurrent || snapshot.value !== input.expectedValue) {
		throw new AdminDealFulfillmentSyncError('Состояние сделки или документов изменилось. Диагностика будет обновлена без записи.');
	}
	if (snapshot.current === snapshot.value) return { previous: input.expectedCurrent, value: snapshot.value, changed: false };

	await client.call('crm.deal.update', { id: input.dealId, fields: { [DEAL_FULFILLMENT_FIELD]: snapshot.value } });
	const confirmed = await client.call<Record<string, unknown>>('crm.deal.get', { id: input.dealId });
	const stored = String(confirmed[DEAL_FULFILLMENT_FIELD] ?? '').trim().toLocaleUpperCase('ru-RU');
	if (stored !== snapshot.value) throw new Error('Битрикс24 не подтвердил новое значение технического поля сделки.');
	return { previous: input.expectedCurrent, value: snapshot.value, changed: true };
}
