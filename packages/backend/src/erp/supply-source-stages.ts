import { parseSupplySourceStages, type SupplySourceStage } from '@b24-app/shared';
import type { ErpClient } from './client.js';
import { listDealStages } from './deal-plan.js';

export const SUPPLY_SOURCE_STAGES_FIELD = 'b24_supply_source_stages';
const ensured = new Set<string>();
export async function ensureSupplySourceStagesField(erp: ErpClient, dt: string): Promise<void> {
	if (ensured.has(dt)) return;
	if (!(await erp.get('Custom Field', `${dt}-${SUPPLY_SOURCE_STAGES_FIELD}`))) {
		await erp.create('Custom Field', { dt, fieldname: SUPPLY_SOURCE_STAGES_FIELD,
			label: 'B24 Supply Source Stages', fieldtype: 'Long Text', read_only: 1 });
	}
	ensured.add(dt);
}

/** Names are resolved by the server, never accepted from the browser. Old clients remain unlabelled. */
export async function resolveSupplySourceStages(erp: ErpClient, dealId: number,
	lines: Array<{ productId: number; stageId?: string }>): Promise<SupplySourceStage[]> {
	if (!lines.some((line) => line.stageId !== undefined)) return [];
	if (lines.some((line) => !line.stageId)) throw new Error('Не определён этап позиции. Обновите сделку и повторите заказ.');
	const stages = await listDealStages(erp, dealId);
	return parseSupplySourceStages(lines.map((line) => {
		if (line.stageId === 'base') return { id: 'base', name: 'Основная сделка' };
		const index = stages.findIndex((stage) => stage.id === line.stageId);
		const stage = stages[index];
		if (!stage || !stage.items.some((item) => item.productId === line.productId)) {
			throw new Error('Этап или товар в этапе изменился. Обновите сделку и повторите заказ.');
		}
		return { id: stage.id, name: stage.name?.trim() || `Этап ${index + 1}` };
	}));
}
