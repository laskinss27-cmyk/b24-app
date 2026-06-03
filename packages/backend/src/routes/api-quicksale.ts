import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';

/**
 * «Быстрая продажа» — создание сделки в категории 6 из корзины Базы товаров.
 *
 * ПИШУЩАЯ операция (первая в приложении) — максимум аккуратности:
 *  - токен самого менеджера (BX24.getAuth) → права Битрикса соблюдаются;
 *  - домен сверяем с порталом (allowlist);
 *  - создаём ОДНУ сделку (CATEGORY_ID 6, стартовая стадия C6:NEW «Подбор оборудования»),
 *    в неё мультипозиционную корзину через crm.deal.productrows.set;
 *  - кассу/оплату НЕ трогаем (нет sale.* / salescenter — менеджер платит нативно в сделке);
 *  - клиента не привязываем — менеджер добавит контакт в карточке.
 * Обратимо: сделку всегда можно удалить (crm.deal.delete).
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}
interface CartItem {
	productId?: number;
	name?: string;
	price?: number;
	quantity?: number;
}

const QUICKSALE_CATEGORY_ID = 6;
const QUICKSALE_START_STAGE = 'C6:NEW';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerApiQuicksaleRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	app.post('/api/quicksale/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { items?: CartItem[]; assignedById?: string | number; title?: string };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		// валидация корзины
		const items = Array.isArray(b.items)
			? b.items
					.map((it) => ({ productId: Number(it.productId), name: String(it.name ?? ''), price: Number(it.price ?? 0), quantity: Number(it.quantity ?? 0) }))
					.filter((it) => it.productId > 0 && it.quantity > 0)
			: [];
		if (!items.length) return reply.code(400).send({ ok: false, error: 'пустая корзина' });

		const title = (b.title && String(b.title).trim()) || `Быстрая продажа ${new Date().toLocaleDateString('ru-RU')}`;
		const assignedById = Number(b.assignedById ?? 0) || undefined;

		try {
			// 1. Сделка в категории 6, стартовая стадия
			const dealId = await client.call<number>('crm.deal.add', {
				fields: {
					TITLE: title,
					CATEGORY_ID: QUICKSALE_CATEGORY_ID,
					STAGE_ID: QUICKSALE_START_STAGE,
					...(assignedById ? { ASSIGNED_BY_ID: assignedById } : {}),
					OPENED: 'Y',
				},
			});
			if (!dealId || dealId <= 0) throw new Error('crm.deal.add не вернул ID');

			// 2. Корзина → строки товаров
			await client.call('crm.deal.productrows.set', {
				id: dealId,
				rows: items.map((it) => ({
					PRODUCT_ID: it.productId,
					PRODUCT_NAME: it.name || undefined,
					PRICE: it.price,
					QUANTITY: it.quantity,
				})),
			});

			app.log.info({ dealId, items: items.length, assignedById }, '[api/quicksale/create] ok');
			return { ok: true, dealId };
		} catch (err) {
			app.log.error({ items: items.length }, `[api/quicksale/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
