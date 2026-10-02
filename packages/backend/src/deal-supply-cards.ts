import type { B24Client } from './b24/client.js';
import { withSupplySourceStages } from '@b24-app/shared';
import { ErpClient } from './erp/client.js';
import { listSupplyRequestsForDeal } from './erp/operations.js';
import { calculateRequestProgress } from './supply/progress.js';
import { loadSupplyOrderProgress } from './routes/api-supply-order-progress.js';

// ── Снабжение (смарт-процесс «Снабжение», разведка 2026-06-11) ────────────────────────────────
// Карточки «Поставка № N_<сделка>_<название>», parentId2 = сделка, перечень — текстовое поле.
export const SUPPLY_TYPE_ID = 1110;
export const SUPPLY_CATEGORY_ID = 114;
export const SUPPLY_LIST_FIELD = 'ufCrm38_1777818101'; // перечень оборудования (текст, «Комментарий»)
export const SUPPLY_NUMBER_FIELD = 'ufCrm38_1777817940'; // номер поставки (счётчик в карточках)
export const SUPPLY_STORE_FIELD = 'ufCrm38_1778141770'; // «Склад поставки (приход)» — элемент iblock 60
const SUPPLY_STORE_IBLOCK = 60;
export const DEAL_SUPPLY_CREATED_FLAG = 'UF_CRM_1777817683'; // галка сделки «Заявка снабжения создана»

/** Элемент справочника складов процесса (iblock 60) по имени склада каталога.
 *  lists-scope может отсутствовать у токена — тогда null (склад уедет строкой в перечень). */
export async function resolveSupplyStore(client: B24Client, storeName: string): Promise<number | null> {
	if (!storeName) return null;
	try {
		const els = await client.call<Array<Record<string, unknown>>>('lists.element.get', {
			IBLOCK_TYPE_ID: 'lists', IBLOCK_ID: SUPPLY_STORE_IBLOCK,
		});
		const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
		const want = norm(storeName);
		const exact = (els ?? []).find((e) => norm(String(e['NAME'] ?? '')) === want);
		if (exact) return Number(exact['ID']);
		const partial = (els ?? []).find((e) => {
			const n = norm(String(e['NAME'] ?? ''));
			return n.includes(want) || want.includes(n);
		});
		return partial ? Number(partial['ID']) : null;
	} catch {
		return null;
	}
}

export interface SupplyCard {
	id: number;
	closed?: boolean;
	title: string;
	stageId: string;
	source?: 'b24' | 'core';
	productIds?: number[];
	date?: string;
	deadline?: string;
	toStore?: string;
	note?: string;
	items?: Array<{ productId: number; itemName: string; qty: number; note: string }>;
}

export async function listSupplyCards(client: B24Client, dealId: number): Promise<SupplyCard[]> {
	const res = await client.call<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
		entityTypeId: SUPPLY_TYPE_ID,
		filter: { parentId2: dealId },
		select: ['id', 'title', 'stageId'],
		order: { id: 'desc' },
	});
	return (res?.items ?? []).map((i) => ({ id: Number(i['id']), title: String(i['title'] ?? ''), stageId: String(i['stageId'] ?? '') }));
}

export async function listCoreSupplyCards(dealId: number, client: B24Client, erp = ErpClient.fromEnv()): Promise<SupplyCard[]> {
	if (!erp) throw new Error('ядро склада не подключено');
	const requests = await listSupplyRequestsForDeal(erp, dealId);
	if (!requests.length) return [];
	const progress = await loadSupplyOrderProgress(erp, client, requests);
	return requests.map((r) => {
		const closed = ['Transferred', 'Issued', 'Received', 'Stopped'].includes(r.status) || calculateRequestProgress(
			r.items, progress.planned.get(r.requestKey) ?? new Map(),
			progress.fulfilled.get(r.requestKey) ?? new Map(), progress.cancelled.get(r.requestKey) ?? new Map(),
		).closed;
		return {
			id: 0,
			closed,
			title: withSupplySourceStages(`${r.name}${r.toStore ? ` - ${r.toStore}` : ''}`, r.sourceStages),
			stageId: `CORE:${closed && r.status !== 'Stopped' ? 'Completed' : r.status || 'Draft'}`,
			source: 'core',
			productIds: r.productIds,
			date: r.date,
			deadline: r.deadline,
			toStore: r.toStore,
			note: r.note,
			items: r.items,
		};
	});
}
