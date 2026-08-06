import type { ErpClient } from './client.js';
import { DEAL_FIELD, TECH_CUSTOMER, TECH_SUPPLIER, UOM, ensureErpSetup } from './erp-setup.js';
import { b24StoreTitle, erpContext, erpWarehouse } from './warehouse-context.js';

// ── Ремонтное оборудование: позиция на складе ядра под принятый в ремонт аппарат ──
// Живёт ТОЛЬКО в ядре (productId Б24 нет) → код строковый `REPAIR-<номер>`. Строковый код
// автоматически невидим в продажных остатках (везде фильтр productId>0 отсекает нечисловые),
// а группа «Ремонтное оборудование» — для явного поиска и фильтра по контексту.
export const REPAIR_ITEM_GROUP = 'Ремонтное оборудование';
let repairGroupDone = false;
async function ensureRepairItemGroup(erp: ErpClient): Promise<void> {
	if (repairGroupDone) return;
	if (!(await erp.get('Item Group', REPAIR_ITEM_GROUP))) {
		await erp.create('Item Group', { item_group_name: REPAIR_ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
	}
	repairGroupDone = true;
}

/** Завести позицию ремонтного аппарата в ядре (строковый код, группа «Ремонтное оборудование»). Идемпотентно. */
export async function ensureRepairItem(erp: ErpClient, args: { itemCode: string; itemName: string }): Promise<void> {
	if (await erp.get('Item', args.itemCode)) return;
	if (!(await erp.get('UOM', UOM))) await erp.create('UOM', { uom_name: UOM });
	await ensureRepairItemGroup(erp);
	await erp.create('Item', {
		item_code: args.itemCode,
		item_name: args.itemName || args.itemCode,
		item_group: REPAIR_ITEM_GROUP,
		stock_uom: UOM,
		is_stock_item: 1,
		description: `Принято в ремонт (${args.itemCode})`,
	});
}

/** Переименовать позицию ремонта (менеджер поправил название/клиента) — без движения остатка.
 *  Один Item на аппарат: правим имя, а не плодим позиции, иначе на складе остаются «призраки». */
export async function renameRepairItem(erp: ErpClient, args: { itemCode: string; itemName: string }): Promise<void> {
	const it = await erp.get('Item', args.itemCode);
	if (!it || !args.itemName) return;
	if (String(it['item_name'] ?? '') === args.itemName) return;
	await erp.update('Item', args.itemCode, { item_name: args.itemName });
}

/** Принять 1 шт ремонтного аппарата на склад приёмки (Purchase Receipt, rate 0, сразу проведён).
 *  Заводит позицию, если её ещё нет. Возвращает имя проведённого документа. */
export async function receiveRepairUnit(erp: ErpClient, args: { itemCode: string; itemName: string; storeTitle: string }): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	await ensureRepairItem(erp, { itemCode: args.itemCode, itemName: args.itemName });
	const existing = await locateRepairUnit(erp, args.itemCode);
	if (existing) return { name: '' };
	const doc = await erp.create('Purchase Receipt', {
		company: ctx.company,
		supplier: TECH_SUPPLIER,
		set_posting_time: 1,
		items: [{
			item_code: args.itemCode,
			qty: 1,
			warehouse: erpWarehouse(ctx, args.storeTitle),
			rate: 0,
			allow_zero_valuation_rate: 1,
		}],
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Purchase Receipt', name);
	} catch (err) {
		await erp.delete('Purchase Receipt', name).catch(() => undefined);
		throw err;
	}
	return { name };
}

export interface RepairUnitLocation {
	storeTitle: string;
	qty: number;
}

/** Фактическое местонахождение клиентского аппарата берём из Bin, а не из кэша карточки ремонта. */
export async function locateRepairUnit(erp: ErpClient, itemCode: string): Promise<RepairUnitLocation | null> {
	const ctx = await erpContext(erp);
	const bins = await erp.list('Bin', ['warehouse', 'actual_qty'], [['item_code', '=', itemCode]]);
	const nonZero = bins
		.map((bin) => ({
			storeTitle: b24StoreTitle(ctx, String(bin['warehouse'] ?? '')),
			qty: Number(bin['actual_qty'] ?? 0),
		}))
		.filter((bin) => Math.abs(bin.qty) > 0.000001);
	if (!nonZero.length) return null;
	const total = nonZero.reduce((sum, bin) => sum + bin.qty, 0);
	if (nonZero.some((bin) => bin.qty < 0) || nonZero.length !== 1 || Math.abs(total - 1) > 0.000001) {
		const details = nonZero.map((bin) => `${bin.storeTitle}: ${bin.qty}`).join(', ');
		throw new Error(`ремонтная позиция ${itemCode}: ожидалась 1 штука на одном складе, найдено ${details || '0'}`);
	}
	return nonZero[0]!;
}

/** Перемещение 1 шт ремонтного аппарата между складами (Stock Entry: Material Transfer, сразу проведён).
 *  fromStore/toStore — названия складов Б24 (включая транзит `Goods In Transit`). Движение по смене статуса ремонта. */
export async function moveRepairUnit(erp: ErpClient, args: { itemCode: string; fromStore: string; toStore: string }): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		items: [{
			item_code: args.itemCode,
			qty: 1,
			s_warehouse: erpWarehouse(ctx, args.fromStore),
			t_warehouse: erpWarehouse(ctx, args.toStore),
			allow_zero_valuation_rate: 1,
		}],
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Stock Entry', name);
	} catch (err) {
		await erp.delete('Stock Entry', name).catch(() => undefined);
		throw err;
	}
	return { name };
}

/** Списать ремонтный аппарат со склада при выдаче клиенту (Delivery Note, цена 0 — не продаём, выдаём владельцу).
 *  Привязка к сделке через b24_deal_id → документ виден в реализациях сделки. Сразу проведён. */
export async function deliverRepairUnit(erp: ErpClient, args: { itemCode: string; storeTitle: string; dealId?: number }): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	// Повтор после сетевой/ERP-ошибки не должен плодить документы. Проведённую выдачу
	// используем повторно, старый черновик той же ремонтной позиции удаляем.
	const childRows = await erp.list('Delivery Note Item', ['name'], [['item_code', '=', args.itemCode]]);
	for (const childHead of childRows) {
		const childName = String(childHead['name'] ?? '');
		const child = childName ? await erp.get<Record<string, unknown>>('Delivery Note Item', childName) : null;
		const parentName = String(child?.['parent'] ?? '');
		if (!parentName) continue;
		const parent = await erp.get<Record<string, unknown>>('Delivery Note', parentName);
		if (!parent) continue;
		if (args.dealId && String(parent[DEAL_FIELD] ?? '') !== String(args.dealId)) continue;
		const docstatus = Number(parent['docstatus'] ?? 0);
		if (docstatus === 1) return { name: parentName };
		if (docstatus === 0) await erp.delete('Delivery Note', parentName);
	}
	const doc = await erp.create('Delivery Note', {
		company: ctx.company,
		customer: TECH_CUSTOMER,
		set_posting_time: 1,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		items: [{
			item_code: args.itemCode,
			qty: 1,
			warehouse: erpWarehouse(ctx, args.storeTitle),
			rate: 0,
			allow_zero_valuation_rate: 1,
		}],
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Delivery Note', name);
	} catch (err) {
		await erp.delete('Delivery Note', name).catch(() => undefined);
		throw err;
	}
	return { name };
}
