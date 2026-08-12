import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { mergeRepairServiceLine, setDealB24CollapsedService } from '../deal-service.js';
import { ErpClient } from '../erp/client.js';
import { calculateDealPlanTotal, listDealPlan, upsertDealPlan } from '../erp/operations.js';
import type { RepairData } from './repair-record.js';

export function selectFailedDealStage(stages: Array<Record<string, unknown>>, categoryId: number): string {
	const failed = (Array.isArray(stages) ? stages : []).filter((stage) => String(stage['SEMANTICS'] ?? '').toUpperCase() === 'F');
	const preferred = failed.find((stage) => /(^|:)LOSE$/i.test(String(stage['STATUS_ID'] ?? ''))) ?? failed[0];
	const stageId = String(preferred?.['STATUS_ID'] ?? '');
	if (!stageId) throw new Error(`в направлении сделки ${categoryId || 0} не найден этап отказа`);
	return stageId;
}

async function failedDealStage(client: B24Client, categoryId: number): Promise<string> {
	const entityId = categoryId > 0 ? `DEAL_STAGE_${categoryId}` : 'DEAL_STAGE';
	const stages = await client.call<Array<Record<string, unknown>>>('crm.status.list', {
		filter: { ENTITY_ID: entityId },
		order: { SORT: 'ASC' },
	});
	return selectFailedDealStage(stages, categoryId);
}

export async function cancelRefusedRepairDeal(
	client: B24Client,
	data: RepairData,
	log: FastifyInstance['log'],
): Promise<void> {
	if (!data.dealId) return;
	const dealId = data.dealId;
	const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	const categoryId = Number(deal?.['CATEGORY_ID'] ?? 0);
	const stageId = await failedDealStage(client, categoryId);
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('ядро склада недоступно — услуга ремонта не снята из сделки');
	const currentPlan = await listDealPlan(erp, dealId);
	const lines = mergeRepairServiceLine(currentPlan, 'warranty', 0);
	await upsertDealPlan(erp, dealId, lines, new Date().toISOString().slice(0, 10));
	const total = await calculateDealPlanTotal(erp, dealId);
	await setDealB24CollapsedService(client, dealId, total);
	await client.call('crm.deal.update', {
		id: dealId,
		fields: { STAGE_ID: stageId, IS_MANUAL_OPPORTUNITY: 'Y', OPPORTUNITY: total },
	});
	client.call('crm.timeline.comment.add', {
		fields: {
			ENTITY_ID: dealId,
			ENTITY_TYPE: 'deal',
			COMMENT: `Клиент отказался от ремонта. Причина: ${data.clientRefusal?.reason ?? 'не указана'}`,
		},
	}).catch((error) => log.warn({ dealId, error: String(error) }, '[repairs/refuse] timeline comment failed'));
}

export async function reframeRefusedRepairTask(client: B24Client, data: RepairData, repairId: number): Promise<void> {
	if (!data.taskId) return;
	const current = await client.call<{ task?: { description?: string } }>('tasks.task.get', {
		taskId: data.taskId,
		select: ['ID', 'DESCRIPTION'],
	});
	const marker = `Клиент отказался от ремонта: ${data.clientRefusal?.reason ?? 'причина не указана'}`;
	const description = String(current?.task?.description ?? '');
	await client.call('tasks.task.update', {
		taskId: data.taskId,
		fields: {
			TITLE: `Вернуть оборудование клиенту — ремонт #${data.repairNo || repairId}`,
			DESCRIPTION: description.includes(marker) ? description : `${description}\n\n${marker}`.trim(),
		},
	});
}

export async function completeRefusedRepairTask(client: B24Client, data: RepairData): Promise<void> {
	if (!data.clientRefusal || !data.taskId) return;
	await client.call('tasks.task.complete', { taskId: data.taskId });
}
