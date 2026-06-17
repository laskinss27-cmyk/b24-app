/**
 * WRITE-ТЕСТ (net-zero): пробуем пробить СТЕНУ 1 через crm.orderentity.
 * План: своя тест-сделка + товарная строка → sale.order.add (externalOrder=Y) →
 * смотрим дубль-сделку → убиваем дубль и его привязку → orderentity.add к НАШЕЙ сделке →
 * basketitem с xmlId=crm_pr_<rowId> → проверка чтением. Дубль чистим сразу;
 * тест-сделку+заказ ОСТАВЛЯЕМ для визуальной проверки Сергеем (потом зачистим).
 * Запуск: npx tsx scripts/test-orderentity-netzero.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
const PRODUCT = 16498; // кабель FTP 5E, 45₽ — копеечный
const PRICE = 45;
function j(l: string, d: unknown): void { let s = JSON.stringify(d); if (s && s.length > 800) s = s.slice(0, 800) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T> {
	try { return await c.call<T>(m, p); }
	catch (e) { const msg = e instanceof B24ApiError ? `${e.code}: ${e.description ?? ''}` : String(e); console.log(`  ⛔ ${m} → ${msg.slice(0, 160)}`); throw e; }
}
async function soft<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { const msg = e instanceof B24ApiError ? `${e.code}: ${e.description ?? ''}` : String(e); console.log(`  🟡 ${m} → ${msg.slice(0, 160)}`); return null; }
}
const bindings = async (orderId: number) =>
	((await soft<{ orderEntity?: Array<Record<string, unknown>> }>('crm.orderentity.list', { filter: { orderId }, select: ['*'] }))?.orderEntity) ?? [];

(async () => {
	console.log('0) чищу осиротевшую тест-сделку 36752 (с прошлого прогона)');
	await soft('crm.deal.delete', { id: 36752 });

	console.log('1) создаю ТЕСТ-СДЕЛКУ');
	const DEAL = Number(await tc<number>('crm.deal.add', { fields: { TITLE: 'ТЕСТ orderentity — НЕ ТРОГАТЬ (автоудаление)', CATEGORY_ID: 0 } }));
	console.log('   сделка', DEAL);

	console.log('2) кладу в сделку товарную строку (для crm_pr_)');
	const row = await tc<{ productRow?: Record<string, unknown> }>('crm.item.productrow.add', {
		fields: { ownerType: 'D', ownerId: DEAL, productId: PRODUCT, price: PRICE, quantity: 2 },
	});
	const ROWID = Number(row?.productRow?.['id']);
	console.log('   строка сделки', ROWID);

	console.log('3) создаю ЗАКАЗ (externalOrder=Y) — смотрим, родится ли дубль-сделка');
	const ord = await tc<{ order?: { id?: number } }>('sale.order.add', {
		fields: { lid: 's1', personTypeId: 6, currency: 'RUB', userId: 22, externalOrder: 'Y' },
	});
	const ORDER = Number(ord?.order?.id);
	console.log('   заказ', ORDER);

	console.log('4) читаю авто-привязки заказа (есть ли дубль?)');
	let b = await bindings(ORDER);
	j('   привязки', b);
	const dupDeal = b.find((x) => Number(x['ownerTypeId']) === 2 && Number(x['ownerId']) !== DEAL);

	if (dupDeal) {
		const DUP = Number(dupDeal['ownerId']);
		console.log(`5) ДУБЛЬ-СДЕЛКА ${DUP} создалась → чищу её и привязку`);
		const dup = await soft<Record<string, unknown>>('crm.deal.get', { id: DUP });
		const dupContact = Number(dup?.['CONTACT_ID'] ?? 0);
		await soft('crm.orderentity.deleteByFilter', { fields: { orderId: ORDER, ownerId: DUP, ownerTypeId: 2 } });
		await soft('crm.deal.delete', { id: DUP });
		if (dupContact > 0) { console.log('   контакт дубля', dupContact, '→ удаляю'); await soft('crm.contact.delete', { id: dupContact }); }
	} else {
		console.log('5) 🎉 дубль-сделка НЕ создалась (externalOrder=Y сработал?)');
	}

	console.log('6) ПРИВЯЗЫВАЮ заказ к НАШЕЙ сделке: crm.orderentity.add');
	const added = await soft('crm.orderentity.add', { fields: { orderId: ORDER, ownerId: DEAL, ownerTypeId: 2 } });
	j('   результат add', added);

	console.log('7) строка корзины с xmlId=crm_pr_' + ROWID);
	const bi = await soft<{ basketItem?: { id?: number } }>('sale.basketitem.add', {
		fields: { orderId: ORDER, productId: PRODUCT, quantity: 2, price: PRICE, currency: 'RUB', name: 'Компьютерный кабель FTP 5E (тест)', xmlId: `crm_pr_${ROWID}` },
	});
	console.log('   basketItem', bi?.basketItem?.id ?? '(не создан)');

	console.log('8) КОНТРОЛЬ: привязки заказа теперь');
	b = await bindings(ORDER);
	j('   привязки', b);
	const okBind = b.some((x) => Number(x['ownerId']) === DEAL && Number(x['ownerTypeId']) === 2);

	console.log('\n================= ИТОГ =================');
	console.log(okBind
		? `✅ СТЕНА 1 ПРОБИТА: заказ ${ORDER} привязан к НАШЕЙ сделке ${DEAL} через crm.orderentity!`
		: `❌ привязка к нашей сделке НЕ встала — стена держится`);
	console.log(`Тест-сделка ${DEAL} и заказ ${ORDER} ОСТАВЛЕНЫ для визуальной проверки (потом зачистим).`);
	console.log(`Сергею посмотреть: карточка сделки ${DEAL} → видна ли реализация/заказ в UI.`);
})().catch((e) => { console.error('FATAL — тест прерван:', e instanceof B24ApiError ? e.message : e); });
