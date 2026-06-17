/**
 * Read-only: как у НАТИВНЫХ заказов реализаций устроен клиент.
 *  - userId/personTypeId заказов 954/950/948/946/772 + их propertyvalues
 *  - сделки этих заказов: CONTACT_ID/COMPANY_ID
 *  - есть ли способ найти sale-юзера по контакту (user.get по email/телефону? buyer-методы?)
 * Запуск: npx tsx scripts/recon-order-client.ts
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
	const dealByOrder: Record<number, number> = { 954: 36750, 950: 36746, 948: 36744, 946: 32648, 772: 36512 };
	for (const [orderId, dealId] of Object.entries(dealByOrder).map(([o, d]) => [Number(o), d] as const)) {
		const ord = await tc<{ order?: Record<string, unknown> }>('sale.order.get', { id: orderId });
		const o = ord?.order ?? {};
		console.log(`\nзаказ ${orderId}: userId=${o['userId']} personTypeId=${o['personTypeId']} companyId=${o['companyId']} price=${o['price']}`);
		const pv = await tc<{ propertyValues?: Array<Record<string, unknown>> }>('sale.propertyvalue.list', { filter: { orderId } });
		for (const p of pv?.propertyValues ?? []) console.log(`   prop ${p['orderPropsId']} «${p['name']}» = ${JSON.stringify(p['value'])}`);
		const deal = await tc<Record<string, unknown>>('crm.deal.get', { id: dealId });
		console.log(`   сделка ${dealId}: CONTACT_ID=${deal?.['CONTACT_ID']} COMPANY_ID=${deal?.['COMPANY_ID']} TITLE=${String(deal?.['TITLE']).slice(0, 40)}`);
		const uid = Number(o['userId']);
		if (uid) {
			const u = await tc<Array<Record<string, unknown>>>('user.get', { ID: uid });
			const usr = (u ?? [])[0];
			console.log(`   sale-юзер ${uid}: ${usr?.['NAME']} ${usr?.['LAST_NAME']} email=${usr?.['EMAIL']} XML_ID=${usr?.['XML_ID']} EXTERNAL_AUTH_ID=${usr?.['EXTERNAL_AUTH_ID']}`);
		}
	}

	console.log('\n=== existence-пробы: запись свойств заказа / buyer-методы ===');
	for (const m of ['sale.propertyvalue.add', 'sale.propertyvalue.update', 'sale.propertyvalue.modify', 'sale.propertyvalue.getfields', 'sale.buyer.list', 'sale.user.list', 'user.search']) {
		try { await c.call(m, {}); console.log(`  ✅ ${m} — ОК`); }
		catch (e) {
			const msg = e instanceof B24ApiError ? `${e.code}:${e.description ?? ''}` : String(e);
			console.log(`  ${/not found/i.test(msg) ? '⛔ НЕТ' : '🟡 ЕСТЬ, ошибка'} ${m} → ${msg.slice(0, 120)}`);
		}
	}
	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e));
