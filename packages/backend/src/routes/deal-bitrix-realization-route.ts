import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ensureRealizeEntity, REALIZE_ENTITY } from '../b24/placement.js';
import { loadDealOrderInfo } from '../deal-order-info.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealBitrixRealizationRoute(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Черновик-партия реализации через нативный заказ и отгрузку Битрикс24.
	app.post('/api/deal/realize', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = (Array.isArray(b.items) ? b.items : [])
			.map((it) => it as { rowId?: unknown; productId?: unknown; quantity?: unknown; rowQuantity?: unknown; price?: unknown; name?: unknown; storeId?: unknown })
			.map((it) => ({
				rowId: Number(it.rowId),
				productId: Number(it.productId),
				quantity: Number(it.quantity),
				rowQuantity: Number(it.rowQuantity ?? it.quantity),
				price: Number(it.price),
				name: String(it.name ?? ''),
				storeId: Number(it.storeId ?? 0),
				storeName: String((it as { storeName?: unknown }).storeName ?? ''),
			}))
			.filter((it) =>
				Number.isInteger(it.rowId) && it.rowId > 0 &&
				Number.isInteger(it.productId) && it.productId > 0 &&
				Number.isFinite(it.quantity) && it.quantity > 0 &&
				Number.isFinite(it.rowQuantity) && it.rowQuantity >= it.quantity &&
				Number.isFinite(it.price) && it.price >= 0);
		if (!items.length) return reply.code(400).send({ ok: false, error: 'no valid items' });

		const created: { orderId?: number; orderReused?: boolean; shipmentId?: number; basketIds: number[]; dupDealId?: number; dupContactId?: number } = { basketIds: [] };
		const step = (s: string): void => { app.log.info({ dealId }, `[api/deal/realize] ${s}`); };
		try {
			const me = await client.call<{ ID?: string | number }>('user.current', {});
			const userId = Number(me?.ID ?? 0);
			if (!userId) throw new Error('user.current не вернул ID');

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

			let storesWritten = 0;
			for (const it of items.filter((x) => Number.isInteger(x.storeId) && x.storeId > 0)) {
				try {
					await client.call('crm.item.productrow.update', { id: it.rowId, fields: { storeId: it.storeId } });
					storesWritten++;
				} catch (err) {
					app.log.warn({ rowId: it.rowId }, `[api/deal/realize] storeId в строку не записался (ожидаемо, поле read-only) — ${errInfo(err)}`);
				}
			}
			if (storesWritten > 0) step(`storeId записан в ${storesWritten} строк`);

			const info = await loadDealOrderInfo(client, dealId);
			let orderId = info.orderId;
			for (const it of items) {
				const already = info.shipped.get(it.rowId) ?? 0;
				if (already + it.quantity > it.rowQuantity + 1e-9) {
					throw new Error(`строка «${it.name || it.rowId}»: к отгрузке ${it.quantity} + уже отгружено ${already} больше количества в сделке ${it.rowQuantity}`);
				}
			}

			if (orderId) {
				created.orderReused = true;
				step(`заказ сделки уже есть (${orderId}) — переиспользую, партия добавится отгрузкой`);
			} else {
				const ord = await client.call<{ order?: { id?: number } }>('sale.order.add', {
					fields: { lid: 's1', personTypeId: 6, currency, userId, externalOrder: 'Y' },
				});
				orderId = Number(ord?.order?.id);
				if (!orderId) throw new Error('sale.order.add не вернул id заказа');
				created.orderId = orderId;
				step(`заказ ${orderId}`);

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

				await client.call('crm.orderentity.add', { fields: { orderId, ownerId: dealId, ownerTypeId: 2 } });
				step(`orderentity → сделка ${dealId}`);
			}

			if (clientName || clientPhone) {
				const propertyValues: Array<{ orderPropsId: number; value: string }> = [];
				if (clientName) propertyValues.push({ orderPropsId: 40, value: clientName });
				if (clientPhone) propertyValues.push({ orderPropsId: 44, value: clientPhone });
				await client.call('sale.propertyvalue.modify', { fields: { order: { id: orderId, propertyValues } } })
					.then(() => step('свойства клиента записаны'))
					.catch((err) => app.log.warn({ orderId }, `[api/deal/realize] propertyvalue.modify не прошёл (не критично) — ${errInfo(err)}`));
			}

			const basketByRow = new Map<number, { basketId: number }>();
			for (const it of items) {
				const existing = info.basket.get(it.rowId);
				if (existing) {
					const already = info.shipped.get(it.rowId) ?? 0;
					if (already + it.quantity > existing.quantity + 1e-9) {
						await client.call('sale.basketitem.update', { id: existing.basketId, fields: { quantity: already + it.quantity } });
						step(`корзина ${existing.basketId}: кол-во увеличено до ${already + it.quantity}`);
					}
					basketByRow.set(it.rowId, { basketId: existing.basketId });
					continue;
				}
				const bi = await client.call<{ basketItem?: { id?: number } }>('sale.basketitem.add', {
					fields: { orderId, productId: it.productId, quantity: it.rowQuantity, price: it.price, currency, name: it.name || `Товар ${it.productId}`, xmlId: `crm_pr_${it.rowId}` },
				});
				const basketId = Number(bi?.basketItem?.id);
				if (!basketId) throw new Error(`sale.basketitem.add не вернул id (строка ${it.rowId})`);
				created.basketIds.push(basketId);
				basketByRow.set(it.rowId, { basketId });
			}
			step(`корзина: ${basketByRow.size} строк (новых ${created.basketIds.length})`);

			const sh = await client.call<{ shipment?: Record<string, unknown> }>('sale.shipment.add', {
				fields: { orderId, deliveryId: 6, allowDelivery: 'N', deducted: 'N' },
			});
			const shipmentId = Number(sh?.shipment?.['id']);
			if (!shipmentId) throw new Error('sale.shipment.add не вернул id');
			created.shipmentId = shipmentId;
			const accountNumber = String(sh?.shipment?.['accountNumber'] ?? '');
			for (const it of items) {
				const basketId = basketByRow.get(it.rowId)?.basketId;
				if (!basketId) continue;
				await client.call('sale.shipmentitem.add', { fields: { orderDeliveryId: shipmentId, basketId, quantity: it.quantity } });
			}
			step(`черновик-партия #${accountNumber} (shipment ${shipmentId}) готов`);

			const stores: Record<string, { storeId: number; storeName: string }> = {};
			for (const it of items) if (it.storeId > 0) stores[String(it.rowId)] = { storeId: it.storeId, storeName: it.storeName };
			if (Object.keys(stores).length) {
				try {
					await ensureRealizeEntity(client);
					await client.call('entity.item.add', {
						ENTITY: REALIZE_ENTITY,
						NAME: `ship_${shipmentId}`,
						DETAIL_TEXT: JSON.stringify({ dealId, orderId, shipmentId, stores }),
					});
					step('склады партии записаны в память приложения');
				} catch (err) {
					app.log.warn({ shipmentId }, `[api/deal/realize] память складов не записалась (не критично) — ${errInfo(err)}`);
				}
			}

			return { ok: true, orderId, orderReused: created.orderReused ?? false, shipmentId, accountNumber, dupRemoved: created.dupDealId ?? null };
		} catch (err) {
			app.log.error({ dealId, created }, `[api/deal/realize] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), created });
		}
	});
}
