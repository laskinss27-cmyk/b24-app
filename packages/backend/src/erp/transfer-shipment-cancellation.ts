import type { ErpClient } from './client.js';
import { erpContext, erpWarehouse } from './warehouse-context.js';
import type { StoredTransfer } from '../transfers/model.js';

/** Reverse only the recorded shipment, at current ERP time. Never rewrite its history. */
export async function reverseMistakenShipment(erp: ErpClient, transfer: StoredTransfer, beforeWrite: () => Promise<void>): Promise<string> {
	if (!transfer.shipEntry) throw new Error('Нет документа отправки; требуется проверка администратора');
	const ship = await erp.get<Record<string, unknown>>('Stock Entry', transfer.shipEntry);
	if (!ship || Number(ship['docstatus']) !== 1 || String(ship['b24_transfer_document']) !== String(transfer.id)
		|| ship['b24_transfer_phase'] !== 'ship' || ship['stock_entry_type'] !== 'Material Transfer') {
		throw new Error('Документ отправки не соответствует перемещению; требуется проверка администратора');
	}
	const rows = await erp.list<Record<string, unknown>>('Stock Entry', ['name', 'docstatus', 'b24_transfer_phase'],
		[['b24_transfer_document', '=', String(transfer.id)], ['docstatus', '!=', 2]], 0);
	if (rows.some(row => row['name'] !== transfer.shipEntry && row['b24_transfer_phase'] !== 'cancel_ship')) {
		throw new Error('По перемещению уже есть приёмка или другая складская операция');
	}
	const reversals = rows.filter(row => row['b24_transfer_phase'] === 'cancel_ship');
	if (reversals.length > 1) throw new Error('Найдено несколько отмен отправки; требуется проверка администратора');
	const ctx = await erpContext(erp);
	if (ship['company'] !== ctx.company) throw new Error('Отправка относится к другой компании');
	const source = erpWarehouse(ctx, transfer.fromStore);
	const items = Array.isArray(ship['items']) ? ship['items'] as Record<string, unknown>[] : [];
	if (!items.length || items.some(item => !Number.isFinite(Number(item['qty'])) || Number(item['qty']) <= 0
		|| item['s_warehouse'] !== source || !item['t_warehouse'])) throw new Error('Строки отправки не соответствуют складу-источнику');
	for (const warehouse of new Set(items.map(item => String(item['t_warehouse'])))) {
		const target = await erp.get<Record<string, unknown>>('Warehouse', warehouse);
		if (target?.['warehouse_type'] !== 'Transit' || target['company'] !== ctx.company) throw new Error('Отправка не находится на транзитном складе');
	}
	const quantities = (lines: Array<{ code: string; qty: number }>) => {
		const map = new Map<string, number>();
		for (const line of lines) map.set(line.code, (map.get(line.code) ?? 0) + line.qty);
		return map;
	};
	const sent = quantities(items.map(item => ({ code: String(item['item_code']), qty: Number(item['qty']) })));
	const expected = quantities(transfer.shippedLines.map(line => ({ code: String(line.productId), qty: line.qty })));
	if (sent.size !== expected.size || [...sent].some(([code, qty]) => Math.abs(qty - (expected.get(code) ?? 0)) > 0.000001)) {
		throw new Error('Количество отправки не совпадает с сохранённым перемещением');
	}
	const reverseItems = items.map(item => ({ item_code: item['item_code'], qty: item['qty'],
		s_warehouse: item['t_warehouse'], t_warehouse: item['s_warehouse'],
		...(item['uom'] ? { uom: item['uom'], conversion_factor: item['conversion_factor'] } : {}),
		...(item['serial_no'] ? { serial_no: item['serial_no'] } : {}),
		...(item['batch_no'] ? { batch_no: item['batch_no'] } : {}) }));
	// Bundled serial/batch movement needs a dedicated reversal workflow, not a copied bundle.
	if (items.some(item => item['serial_and_batch_bundle'])) throw new Error('Для серийного товара требуется проверка администратора');
	let name = reversals[0] ? String(reversals[0]['name']) : '';
	if (name) {
		const existing = await erp.get<Record<string, unknown>>('Stock Entry', name);
		const existingItems = (existing?.['items'] ?? []) as Record<string, unknown>[];
		const signature = (lines: Record<string, unknown>[]) => lines.map(item =>
			JSON.stringify([item['item_code'], Number(item['qty']), item['s_warehouse'], item['t_warehouse'], item['serial_no'] || '', item['batch_no'] || '', item['uom'] || '', Number(item['conversion_factor'] ?? 1)])).sort().join('|');
		if (!existing || existing['company'] !== ship['company'] || existing['stock_entry_type'] !== 'Material Transfer'
			|| String(existing['b24_transfer_document']) !== String(transfer.id) || existing['b24_transfer_phase'] !== 'cancel_ship'
			|| signature(existingItems) !== signature(reverseItems)) {
			throw new Error('Сохранённая отмена не соответствует отправке');
		}
		if (Number(existing['docstatus']) === 1) { await beforeWrite(); return name; }
		if (Number(existing['docstatus']) !== 0) throw new Error('Недопустимый статус отмены отправки');
		await beforeWrite();
	} else {
		await beforeWrite();
		const doc = await erp.create('Stock Entry', { company: ship['company'], stock_entry_type: 'Material Transfer',
			b24_transfer_document: String(transfer.id), b24_transfer_phase: 'cancel_ship',
			b24_deal_id: ship['b24_deal_id'] || '', b24_supply_request: ship['b24_supply_request'] || '',
			b24_supply_request_key: ship['b24_supply_request_key'] || '', b24_purchase_order: ship['b24_purchase_order'] || '',
			remarks: `Отмена ошибочной отправки ${transfer.shipEntry}. ${transfer.shipmentCancellation?.reason ?? ''}`,
			set_posting_time: 0, items: reverseItems });
		name = String(doc['name'] ?? '');
		if (!name) throw new Error('ERP не вернула номер отмены отправки');
	}
	await erp.submit('Stock Entry', name, { useCurrentPostingTime: true });
	return name;
}
