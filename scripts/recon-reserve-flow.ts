/**
 * Read-only: как склад из строки сделки (storeId) доезжает до черновика реализации.
 * Смотрим заказы проведённых реализаций (954/950/948 — storeId 8/14/14 в crm-строках):
 * есть ли у basketItems reservations со storeId, совпадает ли со складом crm-строки.
 * Запуск: npx tsx scripts/recon-reserve-flow.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	for (let a = 1; a <= 4; a++) {
		try { return await c.call<T>(m, p); }
		catch (e) {
			if (e instanceof B24ApiError) { console.log(`  ⛔ ${m} → ${e.code}:${e.description ?? ''}`); return null; }
			if (a === 4) { console.log(`  ⛔ ${m} → ${String(e)} (4 попытки)`); return null; }
			await wait(a * 700);
		}
	}
	return null;
}

(async () => {
	for (const orderId of [954, 950, 948, 772, 956]) {
		console.log(`\n=== заказ ${orderId} ===`);
		const ord = await tc<{ order?: Record<string, unknown> & { basketItems?: Array<Record<string, unknown>> } }>('sale.order.get', { id: orderId });
		for (const b of ord?.order?.basketItems ?? []) {
			console.log(`  basket ${b['id']} ${String(b['name']).slice(0, 36)} qty=${b['quantity']} xmlId=${b['xmlId']}`);
			console.log(`    reservations: ${JSON.stringify(b['reservations'])}`);
		}
	}
	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e instanceof B24ApiError ? `${e.code}:${e.description ?? ''}` : e));
