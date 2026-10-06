import type { DealRepairProfit } from '@b24-app/shared';
import type { B24Client } from './b24/client.js';
import { fetchAllRepairs } from './routes/repair-storage.js';

export interface RepairComposition { repairRevenue?: number; repairQty?: number }
type Row = Record<string, unknown>;
const round = (n: number): number => Math.round(n * 100) / 100;
const price = (v: unknown): number | null =>
	(typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
export const unavailableRepairProfit = (status: string): DealRepairProfit => ({ clientPrice: null, serviceCost: null, profit: null, status });

/** A repair sync creates exactly one service per deal. Ambiguous/stale links must not invent profit. */
export function calculateRepairProfit(dealId: number, composition: RepairComposition, cards: Row[]): DealRepairProfit {
	const linked = cards.filter(card => Number(card.dealId) === dealId && (card.kind == null || card.kind === 'client') && card.payType === 'paid' && !card.clientRefusal);
	if (linked.length !== 1) return unavailableRepairProfit(linked.length ? 'Сделка связана с несколькими платными ремонтами' : 'Не найдена карточка платного ремонта');
	const card = linked[0]!;
	const clientPrice = price(card.ourPrice), serviceCost = price(card.cost);
	const result = { clientPrice, serviceCost, profit: null, status: '' } as DealRepairProfit;
	if (clientPrice == null) return { ...result, status: 'Не заполнена цена клиенту в карточке ремонта' };
	if (serviceCost == null) return { ...result, status: 'Не заполнена цена СЦ в карточке ремонта' };
	if (composition.repairQty !== 1 || composition.repairRevenue == null || !Number.isFinite(composition.repairRevenue) || Math.abs(composition.repairRevenue - clientPrice) > 0.01) {
		return { ...result, status: 'Состав сделки не совпадает с ценой в карточке ремонта' };
	}
	return { clientPrice, serviceCost, profit: round(clientPrice - serviceCost), status: 'Цена клиенту минус цена СЦ' };
}

/** One paginated scan per report, only if repair services are present. Uses the caller's app context. */
export async function readDealRepairProfits(client: B24Client, compositions: Map<number, RepairComposition | null | undefined>): Promise<Map<number, DealRepairProfit>> {
	const candidates = [...compositions].filter(([, c]) => c && (c.repairQty !== undefined || c.repairRevenue !== undefined));
	if (!candidates.length) return new Map();
	try {
		const cards = (await fetchAllRepairs(client)).map(row => {
			const parsed: unknown = JSON.parse(String(row.DETAIL_TEXT ?? '{}'));
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid repair record');
			return parsed as Row;
		});
		return new Map(candidates.map(([id, c]) => [id, calculateRepairProfit(id, c!, cards)]));
	} catch {
		return new Map(candidates.map(([id]) => [id, unavailableRepairProfit('Не удалось прочитать цены ремонтов') ]));
	}
}
