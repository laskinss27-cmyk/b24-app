/**
 * Read-only: полная цепочка РЕАЛИЗАЦИЯ → СДЕЛКА на нескольких свежих отгрузках.
 * shipment → orderId → order.basketItems[].xmlId(crm_pr_N) → productrow.get(N) → ownerType=D/ownerId.
 * Запуск: npx tsx scripts/recon-real2deal-chain.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });
function hr(t: string): void { console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`); }
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	for (let attempt = 1; attempt <= 4; attempt++) {
		try { return await client.call<T>(m, p); }
		catch (e) {
			if (e instanceof B24ApiError) { console.log(`  ⛔ ${m} → ${e.code}:${e.description ?? ''}`); return null; }
			if (attempt === 4) { console.log(`  ⛔ ${m} → ${String(e)} (после 4 попыток)`); return null; }
			await wait(attempt * 800);
		}
	}
	return null;
}

async function dealOfOrder(orderId: number): Promise<{ dealId: number; rows: number; nonCrm: number } | null> {
	const ord = await tc<{ order?: { basketItems?: Array<Record<string, unknown>> } }>('sale.order.get', { id: orderId });
	const basket = ord?.order?.basketItems ?? [];
	let nonCrm = 0; const dealVotes = new Map<number, number>();
	for (const b of basket) {
		const m = /^crm_pr_(\d+)$/.exec(String(b['xmlId'] ?? ''));
		if (!m) { nonCrm++; continue; }
		const pr = await tc<{ productRow?: Record<string, unknown> }>('crm.item.productrow.get', { id: Number(m[1]) });
		const r = pr?.productRow;
		if (r && String(r['ownerType']) === 'D') {
			const id = Number(r['ownerId']);
			dealVotes.set(id, (dealVotes.get(id) ?? 0) + 1);
		}
	}
	if (!dealVotes.size) return null;
	const top = [...dealVotes.entries()].sort((a, b) => b[1] - a[1])[0]!;
	return { dealId: top[0], rows: basket.length, nonCrm };
}

async function main(): Promise<void> {
	hr('Свежие проведённые отгрузки (deducted=Y) — по каждой ищем сделку');
	const ships = await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', {
		select: ['id', 'orderId', 'accountNumber', 'dateInsert'], filter: { deducted: 'Y' }, order: { id: 'DESC' },
	});
	const list = (ships?.shipments ?? []).slice(0, 8);
	let ok = 0;
	for (const s of list) {
		const orderId = Number(s['orderId']);
		const res = await dealOfOrder(orderId);
		if (!res) { console.log(`\n  Реализация ${s['accountNumber']} (заказ ${orderId}) → СДЕЛКА НЕ НАЙДЕНА (нет crm_pr_ в корзине)`); continue; }
		const d = await tc<Record<string, unknown>>('crm.deal.get', { id: res.dealId });
		ok++;
		console.log(`\n  Реализация ${s['accountNumber']}  (заказ ${orderId}, строк ${res.rows}, без crm_pr_ ${res.nonCrm})`);
		console.log(`    → СДЕЛКА #${res.dealId}: "${d?.['TITLE']}"  сумма=${d?.['OPPORTUNITY']}  стадия=${d?.['STAGE_ID']}  closed=${d?.['CLOSEDATE']}`);
	}
	hr(`ИТОГ: ${ok}/${list.length} реализаций успешно разрешены в сделку`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
