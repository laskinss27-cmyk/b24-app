/**
 * СМОУК документа ядра инвентаризации (Stock Reconciliation, 1С-модель):
 * черновик создаётся → проверяем поля → удаляем. Остатки НЕ двигаются (submit не зовём).
 * Запуск: npx tsx scripts/erp-inv-smoke.ts
 */
import 'dotenv/config';
process.env['ERPNEXT_URL'] ??= 'http://localhost:8080';
process.env['ERPNEXT_TOKEN'] ??= 'token REDACTED';

import { ErpClient } from '../packages/backend/src/erp/client.js';
import {
	b24StoreTitle,
	createInventoryRecoDraft,
	deleteInventoryRecoDraft,
	erpContext,
	fetchErpStoreStock,
} from '../packages/backend/src/erp/operations.js';

async function main(): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('нет env ERPNEXT_URL/ERPNEXT_TOKEN');
	const ctx = await erpContext(erp);
	console.log(`Компания: ${ctx.company} (${ctx.abbr})`);

	// живой склад с остатками — берём из Bin первый попавшийся
	const bin = (await erp.list('Bin', ['item_code', 'warehouse', 'actual_qty', 'valuation_rate'], [['actual_qty', '>', 0]], 1))[0];
	if (!bin) throw new Error('в ядре нет остатков — смоуку не на чем работать');
	const storeTitle = b24StoreTitle(ctx, String(bin['warehouse']));
	const productId = Number(bin['item_code']);
	const qty = Number(bin['actual_qty']);
	console.log(`Полигон: товар ${productId} @ «${storeTitle}», остаток ${qty}`);

	const book = await fetchErpStoreStock(erp, storeTitle);
	const b = book.get(productId);
	if (!b || Math.abs(b.qty - qty) > 1e-9) throw new Error(`fetchErpStoreStock разошёлся с Bin: ${JSON.stringify(b)} vs ${qty}`);
	console.log('✓ fetchErpStoreStock читает книгу ядра');

	// черновик: «факт» = остаток+1 (документ-черновик, остатки не трогает)
	const { name } = await createInventoryRecoDraft(erp, {
		invRef: 'smoke:test',
		storeTitle,
		lines: [{ productId, qty: qty + 1, valuation: b.valuation }],
	});
	console.log(`✓ черновик создан: ${name}`);

	const doc = await erp.get(name.startsWith('MAT-RECO') ? 'Stock Reconciliation' : 'Stock Reconciliation', name);
	if (!doc) throw new Error('черновик не читается');
	if (Number(doc['docstatus']) !== 0) throw new Error(`docstatus=${doc['docstatus']}, ожидали 0 (черновик)`);
	if (String(doc['b24_inv_ref']) !== 'smoke:test') throw new Error(`b24_inv_ref=${doc['b24_inv_ref']}`);
	const items = (doc['items'] as Array<Record<string, unknown>>) ?? [];
	if (items.length !== 1 || Number(items[0]?.['qty']) !== qty + 1) throw new Error(`строки: ${JSON.stringify(items.map((i) => i['qty']))}`);
	console.log(`✓ черновик корректен (docstatus 0, b24_inv_ref, qty ${qty + 1})`);

	// остаток не изменился?
	const after = (await fetchErpStoreStock(erp, storeTitle)).get(productId);
	if (!after || Math.abs(after.qty - qty) > 1e-9) throw new Error(`остаток уехал: ${after?.qty} vs ${qty}`);
	console.log('✓ остатки не тронуты');

	await deleteInventoryRecoDraft(erp, name);
	if (await erp.get('Stock Reconciliation', name)) throw new Error('черновик не удалился');
	console.log(`✓ черновик удалён за собой`);

	console.log('\nСМОУК ПРОЙДЕН');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
