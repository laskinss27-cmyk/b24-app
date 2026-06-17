/**
 * Read-only: поле storeId у crm.item.productrow — КТО его заполняет и связан ли он со складом реализации.
 *  1) наша тест-строка 8602 (сделка 36754) — что в storeId
 *  2) свежие ПРОВЕДЁННЫЕ реализации → их сделки → storeId строк (заполняет ли нативный мастер)
 *  3) есть ли storeId в старом методе crm.deal.productrows.get
 * Запуск: npx tsx scripts/recon-productrow-storeid.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function hr(t: string): void { console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`); }
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
	const row = (r: unknown): Record<string, unknown> | null => {
		const o = r as Record<string, unknown> | null;
		return (o?.['productRow'] ?? o?.['item'] ?? o) as Record<string, unknown> | null;
	};

	hr('1) Наша тест-строка 8602 (сделка 36754) — storeId?');
	const r0 = row(await tc('crm.item.productrow.get', { id: 8602 }));
	console.log('  строка 8602:', JSON.stringify(r0));

	hr('2) Свежие ПРОВЕДЁННЫЕ реализации → сделка → storeId строк');
	const sh = await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', {
		filter: { deducted: 'Y', system: 'N' }, order: { id: 'desc' },
		select: ['id', 'orderId', 'accountNumber', 'dateDeducted'],
	});
	const ships = (sh?.shipments ?? []).slice(0, 6);
	const dealIds: number[] = [];
	for (const s of ships) {
		const ord = await tc<{ order?: { basketItems?: Array<Record<string, unknown>> } }>('sale.order.get', { id: Number(s['orderId']) });
		const items = ord?.order?.basketItems ?? [];
		const prIds = items
			.map((b) => /^crm_pr_(\d+)$/.exec(String(b['xmlId'] ?? '')))
			.filter((m): m is RegExpExecArray => !!m)
			.map((m) => Number(m[1]));
		console.log(`\n  реализация #${s['accountNumber']} (заказ ${s['orderId']}, deducted ${s['dateDeducted']}) — crm-строк: ${prIds.length}`);
		for (const id of prIds.slice(0, 4)) {
			const it = row(await tc('crm.item.productrow.get', { id }));
			if (it && it['id'] !== undefined) {
				console.log(`    строка ${id}: deal=${it['ownerId']} product=${String(it['productName']).slice(0, 32)} qty=${it['quantity']} storeId=${JSON.stringify(it['storeId'])}`);
				if (typeof it['ownerId'] === 'number' && !dealIds.includes(it['ownerId'])) dealIds.push(it['ownerId']);
			}
			else console.log(`    строка ${id}: (не прочиталась) raw=${JSON.stringify(it).slice(0, 200)}`);
		}
	}

	hr('3) Старый crm.deal.productrows.get — значения STORE_ID/RESERVE_*');
	for (const dealId of [36754, ...dealIds.slice(0, 5)]) {
		const old = await tc<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
		for (const r of old ?? []) console.log(`  сделка ${dealId} строка ${r['ID']}: ${String(r['PRODUCT_NAME']).slice(0, 30)} | STORE_ID=${JSON.stringify(r['STORE_ID'])} RESERVE_ID=${JSON.stringify(r['RESERVE_ID'])} RESERVE_QTY=${JSON.stringify(r['RESERVE_QUANTITY'])} DATE_RESERVE_END=${JSON.stringify(r['DATE_RESERVE_END'])}`);
	}

	hr('ГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e instanceof B24ApiError ? `${e.code}:${e.description ?? ''}` : e));
