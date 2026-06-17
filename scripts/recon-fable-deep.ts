/**
 * Read-only: НЕпроверенные углы для создания реализации по нашим правилам.
 *  1) crm.orderentity.* — привязка заказа к CRM-сущности (та самая внутренняя связь!)
 *  2) поле externalOrder у заказа (не плодит ли сделку-дубль)
 *  3) crm.item.delivery/payment .add — методы записи
 *  4) контрольный прогон по полному списку methods на пропущенные паттерны
 * Запуск: npx tsx scripts/recon-fable-deep.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function hr(t: string): void { console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`); }
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2200) s = s.slice(0, 2200) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { const r = await c.call<T>(m, p); console.log(`  ✅ ${m} — МЕТОД ЕСТЬ (вернул результат)`); return r; }
	catch (e) {
		const msg = e instanceof B24ApiError ? `${e.code}: ${e.description ?? ''}` : String(e);
		const notFound = /method not found/i.test(msg);
		console.log(`  ${notFound ? '⛔ НЕТ МЕТОДА' : '🟡 ЕСТЬ, но ошибка валидации'} ${m} → ${msg.slice(0, 120)}`);
		return null;
	}
}

(async () => {
	hr('1) crm.orderentity.* — привязка заказ↔CRM (ГЛАВНЫЙ кандидат)');
	const oeFields = await tc('crm.orderentity.getFields', {});
	if (oeFields) j('  поля orderentity', oeFields);
	const oeList = await tc<{ orderEntities?: unknown[] } | unknown[]>('crm.orderentity.list', { filter: {}, select: ['*'] });
	if (oeList) j('  первые привязки (live)', oeList);
	await tc('crm.orderentity.add', {});            // ждём валидационную ошибку = есть
	await tc('crm.orderentity.deleteByFilter', {}); // тоже

	hr('2) Привязки заказа 860 (реализация #860/2 → сделка 32602 — как выглядит связь)');
	const oe860 = await tc('crm.orderentity.list', { filter: { orderId: 860 }, select: ['*'] });
	if (oe860) j('  привязка заказа 860', oe860);

	hr('3) crm.item.delivery / payment — есть ли ЗАПИСЬ');
	await tc('crm.item.delivery.add', {});
	await tc('crm.item.payment.add', {});
	await tc('crm.item.payment.pay', {});

	hr('4) Контрольный прогон списка methods (пропущенные паттерны)');
	const all = (await c.call<string[]>('methods', {}).catch(() => [])) ?? [];
	const re = /(orderentity|documentgenerator|delivery|payment|terminal|salescenter|rpa|externalorder)/i;
	const hits = all.filter((m) => re.test(m)).sort();
	console.log(`  всего методов: ${all.length}; совпадений: ${hits.length}`);
	for (const m of hits) console.log('   ', m);

	hr('5) sale.order.getfields — поле externalOrder (для гипотезы про дубль-сделку)');
	const of = await c.call<{ order?: Record<string, Record<string, unknown>> }>('sale.order.getfields', {}).catch(() => null);
	const ext = of?.order?.['externalOrder'];
	j('  описание externalOrder', ext ?? '(нет такого поля)');

	hr('ГОТОВО');
})().catch((e) => console.error('FATAL', e));
