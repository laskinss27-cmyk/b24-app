/**
 * Read-only: sale.tradebinding.* — привязка заказа к CRM-сделке (как нативная реализация
 * цепляется к существующей сделке, не плодя новую?).
 * Запуск: npx tsx scripts/recon-tradebinding.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2600) s = s.slice(0, 2600) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
(async () => {
	console.log('=== sale.tradebinding.list (без фильтра, первые) — структура привязки ===');
	j('list', await tc('sale.tradebinding.list', { select: ['*'] }));

	console.log('\n=== привязки конкретного заказа (несколько недавних заказов реализаций) ===');
	for (const orderId of [930, 918, 860]) {
		j(`order ${orderId}`, await tc('sale.tradebinding.list', { filter: { orderId }, select: ['*'] }));
	}

	console.log('\n=== sale.tradingplatform.list (площадки — какая = CRM-сделки) ===');
	j('platforms', await tc('sale.tradingplatform.list', { select: ['*'] }));

	console.log('\n=== что у сделки 36730: её заказ(ы)? (ищем orderId через productrow→ничего; пробуем найти заказ по userId сделки) ===');
	const deal = await tc<Record<string, unknown>>('crm.deal.get', { id: 36730 });
	j('сделка 36730 (часть полей)', deal ? { TITLE: deal['TITLE'], CONTACT_ID: deal['CONTACT_ID'], COMPANY_ID: deal['COMPANY_ID'], OPPORTUNITY: deal['OPPORTUNITY'] } : null);

	console.log('\n=== sale.tradebinding.fields через getfields-вариант? пробуем .getfields ===');
	await tc('sale.tradebinding.getfields', {});
})().catch((e) => console.error('FATAL', e));
