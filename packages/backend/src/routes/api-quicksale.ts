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
/** Контакт «Розничный покупатель» по умолчанию (в базе 18 дублей — берём канонический #698). */
const RETAIL_BUYER_CONTACT_ID = 698;

/**
 * Склад (storeId) → значение поля «Источник» (SOURCE_ID, crm_status ENTITY_ID=SOURCE).
 * На портале «Источник» приспособлен под точку продажи; имена точек и складов чуть разные,
 * поэтому маппинг явный (сверено по crm.status.list). Измайловский (#4) и Склад Прихода (#2)
 * пары в «Источниках» не имеют → источник не проставляем.
 */
const STORE_TO_SOURCE: Record<number, string> = {
	8: 'STORE', // Дунайский 64
	10: 'RC_GENERATOR', // Богатырский 15
	12: 'BOOKING', // Тельмана 31
	22: 'CALLBACK', // Фаворского 12
	14: 'REPEAT_SALE', // Московский 131
	16: 'UC_OHJ908', // Железноводская 3, 34
	20: 'UC_XFMW6Q', // Железноводская 3, 23
};

/** Цена строки с учётом скидки %: PRICE = розница×(1−pct/100). Битрикс из неё и DISCOUNT_RATE
 *  восстановит нетто=розница и сумму скидки (проверено разведкой recon-discount). */
function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

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
		const b = (req.body ?? {}) as AuthBody & { items?: CartItem[]; assignedById?: string | number; title?: string; storeId?: number; discountPercent?: number };
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
		// Источник = точка продажи по выбранному складу (пусто, если склад не выбран/без пары).
		const sourceId = b.storeId ? STORE_TO_SOURCE[Number(b.storeId)] : undefined;
		// Скидка % на всю продажу (0..99) — применяется к каждой строке.
		const pct = Math.min(99, Math.max(0, Number(b.discountPercent) || 0));

		try {
			// 1. Сделка: категория 6, стартовая стадия, розничный покупатель, источник=точка.
			const dealId = await client.call<number>('crm.deal.add', {
				fields: {
					TITLE: title,
					CATEGORY_ID: QUICKSALE_CATEGORY_ID,
					STAGE_ID: QUICKSALE_START_STAGE,
					CONTACT_ID: RETAIL_BUYER_CONTACT_ID,
					...(sourceId ? { SOURCE_ID: sourceId } : {}),
					...(assignedById ? { ASSIGNED_BY_ID: assignedById } : {}),
					OPENED: 'Y',
				},
			});
			if (!dealId || dealId <= 0) throw new Error('crm.deal.add не вернул ID');

			// 2. Корзина → строки (скидка %: PRICE=итоговая, DISCOUNT_RATE — для показа скидки в сделке).
			await client.call('crm.deal.productrows.set', {
				id: dealId,
				rows: items.map((it) => ({
					PRODUCT_ID: it.productId,
					PRODUCT_NAME: it.name || undefined,
					PRICE: pct > 0 ? round2(it.price * (1 - pct / 100)) : it.price,
					QUANTITY: it.quantity,
					...(pct > 0 ? { DISCOUNT_TYPE_ID: 2, DISCOUNT_RATE: pct } : {}),
				})),
			});

			app.log.info({ dealId, items: items.length, assignedById, sourceId, pct }, '[api/quicksale/create] ok');
			return { ok: true, dealId };
		} catch (err) {
			app.log.error({ items: items.length }, `[api/quicksale/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
