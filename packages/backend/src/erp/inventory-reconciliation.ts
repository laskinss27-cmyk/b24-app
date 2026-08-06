import { ErpClient } from './client.js';
import { erpContext, erpWarehouse } from './warehouse-context.js';

// ── Инвентаризация: Stock Reconciliation «на основании» точки подсчёта ────────

export const INV_FIELD = 'b24_inv_ref';
let invFieldDone = false;

/** Идемпотентно: custom-поле привязки reco к точке инвентаризации (inv<id>:store<id>). */
async function ensureInvField(erp: ErpClient): Promise<void> {
	if (invFieldDone) return;
	const cfName = `Stock Reconciliation-${INV_FIELD}`;
	if (!(await erp.get('Custom Field', cfName))) {
		await erp.create('Custom Field', {
			dt: 'Stock Reconciliation', fieldname: INV_FIELD, label: 'B24 Inventory',
			fieldtype: 'Data', insert_after: 'purpose', in_standard_filter: 1, in_list_view: 1,
		});
	}
	invFieldDone = true;
}

/** Книжные остатки ядра по ОДНОМУ складу: productId → qty (плюс valuation для reco). */
export async function fetchErpStoreStock(erp: ErpClient, storeTitle: string): Promise<Map<number, { qty: number; valuation: number }>> {
	const ctx = await erpContext(erp);
	const bins = await erp.list('Bin', ['item_code', 'actual_qty', 'valuation_rate'], [['warehouse', '=', erpWarehouse(ctx, storeTitle)]]);
	const out = new Map<number, { qty: number; valuation: number }>();
	for (const b of bins) {
		const productId = Number(b['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		out.set(productId, { qty: Number(b['actual_qty'] ?? 0), valuation: Number(b['valuation_rate'] ?? 0) });
	}
	return out;
}

export interface ErpStoreLine {
	productId: number;
	name: string;
	book: number;
	article: string;
	model: string;
	brand: string;
	section: string;
	/** Путь файла в ядре ('/files/...') — фронт показывает через прокси /api/inventory/erp-image. */
	image: string;
}

/** Полная строка склада из ЯДРА для подсчёта: остаток (Bin>0) + карточка (Item: имя/модель/артикул/бренд/фото).
 *  Заменяет Б24-источник в инвентаризации (всё из ядра, без кусков от Б24). */
export async function fetchErpStoreStockFull(erp: ErpClient, storeTitle: string): Promise<ErpStoreLine[]> {
	const ctx = await erpContext(erp);
	const bins = await erp.list('Bin', ['item_code', 'actual_qty'], [['warehouse', '=', erpWarehouse(ctx, storeTitle)], ['actual_qty', '>', 0]]);
	const ids = [...new Set(bins.map((b) => String(b['item_code'])).filter((c) => /^\d+$/.test(c)))];
	if (!ids.length) return [];
	const itemById = new Map<string, Record<string, unknown>>();
	for (let i = 0; i < ids.length; i += 200) {
		const chunk = ids.slice(i, i + 200);
		const rows = await erp.list('Item', ['name', 'item_name', 'b24_model', 'b24_article', 'b24_brand', 'b24_section', 'image'], [['name', 'in', chunk]]);
		for (const r of rows) itemById.set(String(r['name']), r);
	}
	const out: ErpStoreLine[] = [];
	for (const b of bins) {
		const productId = Number(b['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		const it = itemById.get(String(productId));
		out.push({
			productId,
			name: String(it?.['item_name'] ?? `#${productId}`),
			book: Number(b['actual_qty'] ?? 0),
			article: String(it?.['b24_article'] ?? ''),
			model: String(it?.['b24_model'] ?? ''),
			brand: String(it?.['b24_brand'] ?? ''),
			section: String(it?.['b24_section'] ?? ''),
			image: String(it?.['image'] ?? ''),
		});
	}
	return out;
}

/** Имена товаров ядра пачкой (для болванки): productId → item_name. */
export async function fetchErpItemNames(erp: ErpClient, productIds: number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	for (let i = 0; i < productIds.length; i += 200) {
		const chunk = productIds.slice(i, i + 200).map(String);
		const rows = await erp.list('Item', ['name', 'item_name'], [['name', 'in', chunk]]);
		for (const r of rows) out.set(Number(r['name']), String(r['item_name'] ?? ''));
	}
	return out;
}

export interface InventoryRecoLine {
	productId: number;
	/** Фактический остаток (абсолют, не дельта) — Stock Reco выставляет qty В ЛОБ. */
	qty: number;
	/** Valuation обязателен для строк, где остатка в ядре ещё нет; для прочих шлём текущий из Bin. */
	valuation: number;
}

/**
 * Черновик Stock Reconciliation по точке инвентаризации (1С-модель: «Записать»).
 * Проведение — submitInventoryReco («Провести»), двигает остатки ядра.
 */
export async function createInventoryRecoDraft(
	erp: ErpClient,
	args: { invRef: string; storeTitle: string; lines: InventoryRecoLine[]; postingDate?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureInvField(erp);
	if (!args.lines.length) throw new Error('нет строк с расхождениями — документ не нужен');
	// Разностный счёт обычного reco — Stock Adjustment компании (НЕ Temporary Opening: это не открытие).
	const adj = (await erp.list('Account', ['name'], [['account_type', '=', 'Stock Adjustment'], ['company', '=', ctx.company]]))[0];
	if (!adj) throw new Error(`нет счёта Stock Adjustment у компании «${ctx.company}»`);
	const doc = await erp.create('Stock Reconciliation', {
		company: ctx.company,
		purpose: 'Stock Reconciliation',
		set_posting_time: 1,
		...(args.postingDate ? { posting_date: args.postingDate } : {}),
		expense_account: String(adj['name']),
		[INV_FIELD]: args.invRef,
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			warehouse: erpWarehouse(ctx, args.storeTitle),
			qty: l.qty,
			valuation_rate: Math.max(l.valuation, 0.01),
		})),
	});
	return { name: String(doc['name']) };
}

export async function submitInventoryReco(erp: ErpClient, name: string): Promise<void> {
	await erp.submit('Stock Reconciliation', name);
}

/** Удалить НЕпроведённый черновик reco (отмена «Записать»; болванка-пересоздание). */
export async function deleteInventoryRecoDraft(erp: ErpClient, name: string): Promise<void> {
	const doc = await erp.get('Stock Reconciliation', name);
	if (!doc) return;
	if (Number(doc['docstatus'] ?? 0) !== 0) throw new Error(`${name} уже проведён — удалять нельзя`);
	await erp.request('DELETE', `/api/resource/Stock%20Reconciliation/${encodeURIComponent(name)}`);
}
