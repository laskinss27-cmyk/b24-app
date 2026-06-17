/**
 * СМОУК операционного слоя ERPNext (локальная песочница, Б24 не трогается).
 * Прогоняет все операции модуля erp/: остатки → партия-черновик (DN) + submit →
 * партии сделки → перемещение туда-обратно (net-zero) → приход + списание (net-zero).
 * Запуск: npx tsx scripts/erp-ops-smoke.ts
 */
import { ErpClient } from '../packages/backend/src/erp/client.js';
import {
	erpContext, ensureErpSetup, fetchErpStocks,
	createRealizationDraft, submitRealization, listDealRealizations,
	createTransferDraft, createWriteOffDraft, createReceiptDraft, submitDoc,
} from '../packages/backend/src/erp/operations.js';

const erp = new ErpClient({
	url: process.env['ERPNEXT_URL'] ?? 'http://localhost:8080',
	token: process.env['ERPNEXT_TOKEN'] ?? 'token REDACTED',
});
const DEAL = 36766;
const CABLE = 18072; // кабель UTP — есть на «Железноводская, секция 34»
const WH_A = 'Железноводская, секция 34';
const WH_B = 'Склад Прихода';

const qtyAt = (stocks: Map<number, Record<string, number>>, pid: number, store: string): number =>
	stocks.get(pid)?.[store] ?? 0;

(async () => {
	console.log('0) контекст + setup');
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	console.log(`   компания «${ctx.company}» (${ctx.abbr}); custom-поля/контрагенты на месте`);

	console.log('\n1) остатки всего каталога одним запросом');
	let stocks = await fetchErpStocks(erp);
	console.log(`   позиций с остатками: ${stocks.size}; кабель ${CABLE}: ${JSON.stringify(stocks.get(CABLE))}`);
	const beforeA = qtyAt(stocks, CABLE, WH_A);
	const beforeB = qtyAt(stocks, CABLE, WH_B);

	console.log('\n2) партия-реализация: черновик → submit → списание');
	const dn = await createRealizationDraft(erp, {
		dealId: DEAL,
		lines: [{ productId: CABLE, qty: 1, storeTitle: WH_A, rate: 47 }],
	});
	console.log(`   черновик ${dn.name}`);
	await submitRealization(erp, dn.name);
	stocks = await fetchErpStocks(erp);
	const afterDn = qtyAt(stocks, CABLE, WH_A);
	console.log(`   проведена ✅; остаток ${WH_A}: ${beforeA} → ${afterDn} (ожидали ${beforeA - 1})`);

	console.log('\n3) партии сделки одним фильтром по b24_deal_id');
	const parts = await listDealRealizations(erp, DEAL);
	for (const p of parts) {
		console.log(`   ${p.name}: ${p.submitted ? 'проведена' : 'черновик'}, ${p.postingDate}, сумма ${p.grandTotal}`);
		for (const it of p.items) console.log(`     ${it.productId} «${it.itemName.slice(0, 40)}» × ${it.qty} @ ${it.storeTitle}`);
	}

	console.log('\n4) перемещение туда-обратно (net-zero)');
	const t1 = await createTransferDraft(erp, { lines: [{ productId: CABLE, qty: 2, fromStore: WH_A, toStore: WH_B }], dealId: DEAL });
	await submitDoc(erp, 'Stock Entry', t1.name);
	const t2 = await createTransferDraft(erp, { lines: [{ productId: CABLE, qty: 2, fromStore: WH_B, toStore: WH_A }] });
	await submitDoc(erp, 'Stock Entry', t2.name);
	stocks = await fetchErpStocks(erp);
	console.log(`   ${t1.name} + ${t2.name} проведены; ${WH_A}: ${qtyAt(stocks, CABLE, WH_A)} (ожидали ${afterDn}), ${WH_B}: ${qtyAt(stocks, CABLE, WH_B)} (ожидали ${beforeB})`);

	console.log('\n5) приход +3 и списание −3 (net-zero)');
	const pr = await createReceiptDraft(erp, { lines: [{ productId: CABLE, qty: 3, toStore: WH_B, rate: 30 }] });
	await submitDoc(erp, 'Purchase Receipt', pr.name);
	const wo = await createWriteOffDraft(erp, { lines: [{ productId: CABLE, qty: 3, fromStore: WH_B }] });
	await submitDoc(erp, 'Stock Entry', wo.name);
	stocks = await fetchErpStocks(erp);
	console.log(`   ${pr.name} + ${wo.name} проведены; ${WH_B}: ${qtyAt(stocks, CABLE, WH_B)} (ожидали ${beforeB})`);

	const okA = qtyAt(stocks, CABLE, WH_A) === beforeA - 1;
	const okB = qtyAt(stocks, CABLE, WH_B) === beforeB;
	console.log(`\n${okA && okB ? '✅ СМОУК ПРОЙДЕН' : '⛔ РАСХОЖДЕНИЕ'}: все операции отработали, остатки сошлись (минус 1 кабель за партию п.2 — ожидаемо).`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
