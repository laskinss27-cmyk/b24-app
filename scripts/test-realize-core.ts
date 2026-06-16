/**
 * Тест движка реализации В ЯДРЕ (без деплоя, без Битрикса).
 * Создаёт Delivery Note по выбранному складу → проводит → проверяет, что остаток ядра списался →
 * ОТМЕНЯЕТ документ (возвращает остаток) → проверяет возврат. Net-zero.
 *
 * Запуск (против ядра спейра):
 *   ERPNEXT_URL=http://192.168.0.69:8080 ERPNEXT_TOKEN="token 75a1085fa14560a:10fd22965d81d29" \
 *   TEST_STORE="Измайловский 18Д" npx tsx scripts/test-realize-core.ts
 */
import { ErpClient } from '../packages/backend/src/erp/client.js';
import { createRealizationDraft, submitRealization, fetchErpStoreStock, erpContext } from '../packages/backend/src/erp/operations.js';

const erp = ErpClient.fromEnv();
if (!erp) { console.error('FATAL: нет ERPNEXT_URL/ERPNEXT_TOKEN в env'); process.exit(1); }

const STORE = process.env['TEST_STORE'] ?? 'Измайловский 18Д';
const DEAL = 999999; // фиктивная тест-сделка

async function stockOf(productId: number): Promise<number> {
	return (await fetchErpStoreStock(erp!, STORE)).get(productId)?.qty ?? 0;
}

(async () => {
	const ctx = await erpContext(erp!);
	console.log(`компания: ${ctx.company} | склад: ${STORE}`);

	// товар с остатком ≥ 2 на этом складе
	const stock = await fetchErpStoreStock(erp!, STORE);
	const cand = [...stock.entries()].find(([, v]) => v.qty >= 2);
	if (!cand) { console.error(`FATAL: нет товара с остатком ≥2 на складе «${STORE}»`); process.exit(1); }
	const productId = cand[0];
	const before = cand[1].qty;
	console.log(`\nтовар ${productId}: остаток ДО = ${before}`);

	console.log('→ создаю черновик реализации (1 шт)…');
	const { name } = await createRealizationDraft(erp!, { dealId: DEAL, lines: [{ productId, qty: 1, storeTitle: STORE, rate: 100 }] });
	console.log(`  черновик: ${name}`);

	console.log('→ провожу (submit)…');
	await submitRealization(erp!, name);
	const after = await stockOf(productId);
	console.log(`  остаток ПОСЛЕ = ${after} (ожидаем ${before - 1}) → ${after === before - 1 ? '✅ СПИСАЛОСЬ ВЕРНО' : '❌ НЕ СОШЛОСЬ'}`);

	console.log('→ откат: отменяю документ…');
	await erp!.cancel('Delivery Note', name);
	const restored = await stockOf(productId);
	console.log(`  остаток после отмены = ${restored} (вернулось к ${before}) → ${restored === before ? '✅ ВЕРНУЛОСЬ' : '❌ НЕ ВЕРНУЛОСЬ'}`);

	console.log(`\nтест-документ ${name} отменён (docstatus 2). Net-zero. b24_deal_id=${DEAL}.`);
})().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(1); });
