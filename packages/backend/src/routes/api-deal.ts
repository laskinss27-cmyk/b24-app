import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError, type BatchCall } from '../b24/client.js';
import { normalizeDomain } from '../security.js';

/**
 * API вкладки сделки — «Добавить товар» (пункт 2) и «Реализовать» (черновик реализации).
 *  - /api/deal/search-products — поиск товара по названию (iblock 24+26) + розничная цена (BASE).
 *  - /api/deal/add-product — добавить ОДНУ товарную строку в сделку (crm.item.productrow.add,
 *    ownerType='D'); существующие строки НЕ трогаются (не set-all). Проверено net-zero.
 *  - /api/deal/realize — ЧЕРНОВИК реализации по отмеченным строкам сделки (цикл пробит 2026-06-11):
 *    storeId в crm-строки → sale.order.add → снос свежего дубль-сделки/контакта (авто-рождение
 *    портала) → crm.orderentity.add к НАШЕЙ сделке → basketitem'ы с xmlId=crm_pr_<rowId> →
 *    sale.shipment.add черновиком (deducted=N — СКЛАД НЕ ДВИГАЕМ). Проводит менеджер в нативном UI.
 *
 * ЗАПИСЬ в сделку, но безопасная и обратимая (менеджер удалит строку в карточке).
 * Токен — самого юзера (права Битрикса соблюдаются). Домен — allowlist. За канарейкой (фронт).
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

/** Розничная цена (BASE, catalogGroupId=2) для набора productId — батчем. */
async function fetchBasePrices(client: B24Client, ids: number[]): Promise<Map<number, number>> {
	const map = new Map<number, number>();
	const uniq = [...new Set(ids.filter((x) => x > 0))];
	if (!uniq.length) return map;
	const calls: Record<string, BatchCall> = {};
	for (const id of uniq) calls[`pr${id}`] = { method: 'catalog.price.list', params: { filter: { productId: id, catalogGroupId: 2 }, select: ['productId', 'price'] } };
	const res = await client.callBatch(calls);
	for (const id of uniq) {
		const pr = (res.result[`pr${id}`] as { prices?: Array<Record<string, unknown>> } | undefined)?.prices?.[0];
		if (pr) map.set(id, Number(pr['price'] ?? 0));
	}
	return map;
}

export function registerApiDealRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	// Поиск товара по названию + розничная цена (для пикера «Добавить товар»).
	app.post('/api/deal/search-products', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { q?: string };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const q = String(b.q ?? '').trim();
		if (q.length < 2) return { ok: true, products: [] as Array<{ id: number; name: string; price: number }> };
		try {
			const byName = new Map<string, { id: number; name: string }>();
			for (const iblockId of [24, 26]) {
				const res = await client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
					filter: { iblockId, '%name': q },
					select: ['id', 'iblockId', 'name'], // iblockId обязателен в select
					order: { id: 'ASC' },
				});
				for (const p of res?.products ?? []) {
					const name = String(p['name'] ?? '');
					const id = Number(p['id']);
					if (name && id > 0 && !byName.has(name)) byName.set(name, { id, name });
				}
			}
			const list = [...byName.values()].slice(0, 30);
			const prices = await fetchBasePrices(client, list.map((p) => p.id));
			const products = list.map((p) => ({ ...p, price: prices.get(p.id) ?? 0 }));
			app.log.info({ count: products.length }, '[api/deal/search-products] ok');
			return { ok: true, products };
		} catch (err) {
			app.log.error({}, `[api/deal/search-products] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Добавить НЕСКОЛЬКО товарных строк в сделку за раз (корзина из пикера «Готово»).
	app.post('/api/deal/add-products', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = Array.isArray(b.items) ? b.items : [];
		const clean = items
			.map((it) => it as { productId?: unknown; quantity?: unknown; price?: unknown })
			.map((it) => ({ productId: Number(it.productId), quantity: Number(it.quantity), price: Number(it.price) }))
			.filter((it) => Number.isInteger(it.productId) && it.productId > 0 && Number.isFinite(it.quantity) && it.quantity > 0);
		if (!clean.length) return reply.code(400).send({ ok: false, error: 'no valid items' });

		try {
			// Цены, которых нет в запросе, добираем из BASE одним батчем.
			const need = clean.filter((it) => !Number.isFinite(it.price) || it.price < 0).map((it) => it.productId);
			const basePrices = need.length ? await fetchBasePrices(client, need) : new Map<number, number>();
			let added = 0;
			for (const it of clean) {
				const price = Number.isFinite(it.price) && it.price >= 0 ? it.price : (basePrices.get(it.productId) ?? 0);
				await client.call('crm.item.productrow.add', { fields: { ownerType: 'D', ownerId: dealId, productId: it.productId, price, quantity: it.quantity } });
				added++;
			}
			app.log.info({ dealId, added }, '[api/deal/add-products] ok');
			return { ok: true, added };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/add-products] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// ЧЕРНОВИК РЕАЛИЗАЦИИ по отмеченным строкам сделки. Полный цикл, проверенный 2026-06-11.
	// При ошибке на полпути НИЧЕГО не откатываем — возвращаем createdIds для ручной зачистки
	// (правило Сергея: сущности не удаляем; исключение — свежерождённый дубль, см. ниже).
	app.post('/api/deal/realize', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = (Array.isArray(b.items) ? b.items : [])
			.map((it) => it as { rowId?: unknown; productId?: unknown; quantity?: unknown; price?: unknown; name?: unknown; storeId?: unknown })
			.map((it) => ({
				rowId: Number(it.rowId),
				productId: Number(it.productId),
				quantity: Number(it.quantity),
				price: Number(it.price),
				name: String(it.name ?? ''),
				storeId: Number(it.storeId ?? 0),
			}))
			.filter((it) => Number.isInteger(it.rowId) && it.rowId > 0 && Number.isInteger(it.productId) && it.productId > 0 && Number.isFinite(it.quantity) && it.quantity > 0 && Number.isFinite(it.price) && it.price >= 0);
		if (!items.length) return reply.code(400).send({ ok: false, error: 'no valid items' });

		// Создаваемое по шагам — чтобы при ошибке вернуть Сергею точный список артефактов.
		const created: { orderId?: number; shipmentId?: number; basketIds: number[]; dupDealId?: number; dupContactId?: number } = { basketIds: [] };
		const step = (s: string): void => { app.log.info({ dealId }, `[api/deal/realize] ${s}`); };
		try {
			// 0) Менеджер (userId заказа у нативных реализаций = сотрудник, не клиент — разведка 2026-06-11).
			const me = await client.call<{ ID?: string | number }>('user.current', {});
			const userId = Number(me?.ID ?? 0);
			if (!userId) throw new Error('user.current не вернул ID');

			// 1) Сделка: валюта + контакт (для свойств заказа «Имя Фамилия»/«Телефон»).
			const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
			const currency = String(deal?.['CURRENCY_ID'] ?? 'RUB') || 'RUB';
			const contactId = Number(deal?.['CONTACT_ID'] ?? 0);
			let clientName = '';
			let clientPhone = '';
			if (contactId > 0) {
				const ct = await client.call<Record<string, unknown>>('crm.contact.get', { id: contactId }).catch(() => null);
				clientName = [ct?.['NAME'], ct?.['LAST_NAME']].filter(Boolean).join(' ').trim();
				const phones = ct?.['PHONE'] as Array<{ VALUE?: string }> | undefined;
				clientPhone = String(phones?.[0]?.VALUE ?? '');
			}

			// 2) Склад в строки сделки (crm.item.productrow.storeId — этим полем пользуется нативный
			//    механизм реализации; кандидат-дверь стены 2). Только там, где склад выбран.
			for (const it of items.filter((x) => Number.isInteger(x.storeId) && x.storeId > 0)) {
				await client.call('crm.item.productrow.update', { id: it.rowId, fields: { storeId: it.storeId } });
			}
			step(`storeId записан в ${items.filter((x) => x.storeId > 0).length} строк`);

			// 3) Заказ. ВАЖНО: поле currency (НЕ currencyId); externalOrder=Y от дубля не спасает, но не мешает.
			const ord = await client.call<{ order?: { id?: number } }>('sale.order.add', {
				fields: { lid: 's1', personTypeId: 6, currency, userId, externalOrder: 'Y' },
			});
			const orderId = Number(ord?.order?.id);
			if (!orderId) throw new Error('sale.order.add не вернул id заказа');
			created.orderId = orderId;
			step(`заказ ${orderId}`);

			// 4) Портал авто-рождает дубль-сделку+контакт на каждый sale.order.add — сносим ИМЕННО их.
			//    Гарантии: дубль берём только из авто-привязки этого заказа, чужие ID не трогаем,
			//    и только если сделка создана в последние 15 минут (страховка от любого промаха).
			const bnd = await client.call<{ orderEntity?: Array<Record<string, unknown>> }>('crm.orderentity.list', { filter: { orderId }, select: ['*'] }).catch(() => null);
			const dup = (bnd?.orderEntity ?? []).find((x) => Number(x['ownerTypeId']) === 2 && Number(x['ownerId']) !== dealId);
			if (dup) {
				const dupId = Number(dup['ownerId']);
				const dupDeal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dupId }).catch(() => null);
				const bornMs = Date.parse(String(dupDeal?.['DATE_CREATE'] ?? ''));
				const fresh = Number.isFinite(bornMs) && Date.now() - bornMs < 15 * 60 * 1000;
				if (fresh) {
					const dupContact = Number(dupDeal?.['CONTACT_ID'] ?? 0);
					await client.call('crm.orderentity.deleteByFilter', { fields: { orderId, ownerId: dupId, ownerTypeId: 2 } }).catch(() => null);
					await client.call('crm.deal.delete', { id: dupId });
					created.dupDealId = dupId;
					if (dupContact > 0 && dupContact !== contactId) {
						await client.call('crm.contact.delete', { id: dupContact }).catch(() => null);
						created.dupContactId = dupContact;
					}
					step(`дубль-сделка ${dupId} (+контакт ${dupContact || '—'}) снесена`);
				} else {
					app.log.warn({ dealId, dupId }, '[api/deal/realize] привязка к НЕ свежей сделке — не трогаю');
				}
			}

			// 5) Привязка заказа к НАШЕЙ сделке (стена 1 пробита: метод скрыт из `methods`, но работает).
			await client.call('crm.orderentity.add', { fields: { orderId, ownerId: dealId, ownerTypeId: 2 } });
			step(`orderentity → сделка ${dealId}`);

			// 6) Свойства заказа (клиент в документе) — мягко: формат modify не подтверждён живым тестом,
			//    при ошибке документ просто останется без «Имя Фамилия» (как у части нативных).
			if (clientName || clientPhone) {
				const propertyValues: Array<{ orderPropsId: number; value: string }> = [];
				if (clientName) propertyValues.push({ orderPropsId: 40, value: clientName });
				if (clientPhone) propertyValues.push({ orderPropsId: 44, value: clientPhone });
				await client.call('sale.propertyvalue.modify', { fields: { order: { id: orderId, propertyValues } } })
					.then(() => step('свойства клиента записаны'))
					.catch((err) => app.log.warn({ orderId }, `[api/deal/realize] propertyvalue.modify не прошёл (не критично) — ${errInfo(err)}`));
			}

			// 7) Корзина: строки с xmlId=crm_pr_<rowId> — структура неотличима от нативной (тест 2026-06-11).
			const basketByRow = new Map<number, { basketId: number; quantity: number }>();
			for (const it of items) {
				const bi = await client.call<{ basketItem?: { id?: number } }>('sale.basketitem.add', {
					fields: { orderId, productId: it.productId, quantity: it.quantity, price: it.price, currency, name: it.name || `Товар ${it.productId}`, xmlId: `crm_pr_${it.rowId}` },
				});
				const basketId = Number(bi?.basketItem?.id);
				if (!basketId) throw new Error(`sale.basketitem.add не вернул id (строка ${it.rowId})`);
				created.basketIds.push(basketId);
				basketByRow.set(it.rowId, { basketId, quantity: it.quantity });
			}
			step(`корзина: ${created.basketIds.length} строк`);

			// 8) Черновик отгрузки (deliveryId 6 = «Без доставки» на этом портале; deducted=N — склад не тронут).
			const sh = await client.call<{ shipment?: Record<string, unknown> }>('sale.shipment.add', {
				fields: { orderId, deliveryId: 6, allowDelivery: 'N', deducted: 'N' },
			});
			const shipmentId = Number(sh?.shipment?.['id']);
			if (!shipmentId) throw new Error('sale.shipment.add не вернул id');
			created.shipmentId = shipmentId;
			const accountNumber = String(sh?.shipment?.['accountNumber'] ?? '');
			for (const { basketId, quantity } of basketByRow.values()) {
				await client.call('sale.shipmentitem.add', { fields: { orderDeliveryId: shipmentId, basketId, quantity } });
			}
			step(`черновик реализации #${accountNumber} (shipment ${shipmentId}) готов`);

			return { ok: true, orderId, shipmentId, accountNumber, dupRemoved: created.dupDealId ?? null };
		} catch (err) {
			app.log.error({ dealId, created }, `[api/deal/realize] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), created });
		}
	});

	// Добавить одну товарную строку в сделку (не перезаписывая существующие).
	app.post('/api/deal/add-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; productId?: unknown; quantity?: unknown; price?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const dealId = Number(b.dealId);
		const productId = Number(b.productId);
		const quantity = Number(b.quantity);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'bad productId' });
		if (!Number.isFinite(quantity) || quantity <= 0) return reply.code(400).send({ ok: false, error: 'bad quantity' });

		try {
			// Цена: из запроса (если задана) или розничная BASE.
			let price = Number(b.price);
			if (!Number.isFinite(price) || price < 0) price = (await fetchBasePrices(client, [productId])).get(productId) ?? 0;

			const res = await client.call<{ productRow?: Record<string, unknown> }>('crm.item.productrow.add', {
				fields: { ownerType: 'D', ownerId: dealId, productId, price, quantity },
			});
			const row = res?.productRow;
			app.log.info({ dealId, productId, quantity }, '[api/deal/add-product] ok');
			return { ok: true, row: { id: Number(row?.['id']), name: String(row?.['productName'] ?? ''), price: Number(row?.['price'] ?? price), quantity: Number(row?.['quantity'] ?? quantity) } };
		} catch (err) {
			app.log.error({ dealId, productId }, `[api/deal/add-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
