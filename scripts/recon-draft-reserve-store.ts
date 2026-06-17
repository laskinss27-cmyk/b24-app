/**
 * Read-only: виден ли СКЛАД у ЧЕРНОВИКОВ реализаций через резервы корзины?
 * Когда менеджер выбирает склад в черновике — рождается ли reserve со storeId у basketItem?
 * Если да — склад черновика читается живьём из документа (цепочка отчёта + reservations).
 * Смотрим ВСЕ текущие непроведённые отгрузки + заказ 956 (наш тест, Сергей выбирал склад).
 * Запуск: npx tsx scripts/recon-draft-reserve-store.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	for (let a = 1; a <= 5; a++) {
		try { return await c.call<T>(m, p); }
		catch (e) {
			if (e instanceof B24ApiError) { console.log(`  ⛔ ${m} → ${e.code}:${(e.description ?? '').slice(0, 100)}`); return null; }
			if (a === 5) { console.log(`  ⛔ ${m} → ${String(e)}`); return null; }
			await wait(a * 800);
		}
	}
	return null;
}

(async () => {
	console.log('=== Непроведённые отгрузки (черновики) ===');
	const sh = await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', {
		filter: { deducted: 'N', system: 'N' }, order: { id: 'desc' },
		select: ['id', 'orderId', 'accountNumber', 'dateInsert'],
	});
	const drafts = (sh?.shipments ?? []).slice(0, 8);
	const orderIds = [...new Set(drafts.map((s) => Number(s['orderId'])))];
	if (!orderIds.includes(956)) orderIds.push(956);
	for (const s of drafts) console.log(`  черновик #${s['accountNumber']} (заказ ${s['orderId']}, ${s['dateInsert']})`);

	console.log('\n=== Резервы корзин этих заказов (storeId?) ===');
	for (const orderId of orderIds) {
		const ord = await tc<{ order?: { basketItems?: Array<Record<string, unknown>> } }>('sale.order.get', { id: orderId });
		console.log(`\n  заказ ${orderId}:`);
		for (const b of ord?.order?.basketItems ?? []) {
			const res = (b['reservations'] as Array<Record<string, unknown>>) ?? [];
			console.log(`    basket ${b['id']} «${String(b['name']).slice(0, 38)}» qty=${b['quantity']}`);
			if (res.length) for (const r of res) console.log(`      🎯 RESERVE: storeId=${r['storeId']} qty=${r['quantity']} (${JSON.stringify(r).slice(0, 160)})`);
			else console.log('      reservations: []');
		}
	}

	console.log('\n=== sale.basketitem.getfields — store/reserve-поля схемы ===');
	const bf = await tc<{ basketItem?: Record<string, unknown> }>('sale.basketitem.getfields', {});
	console.log('  ', Object.keys(bf?.basketItem ?? {}).filter((k) => /store|reserv/i.test(k)).join(', ') || '(нет)');

	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e));
