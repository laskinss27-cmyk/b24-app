import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import {
	listCoreMovements, searchErpItems, listActiveStoreTitles,
	ensureSupplier, ensureCoreItem, createReceiptDraft, createWriteOffDraft, submitDoc,
	fetchCoreDocDetail, itemStockLedger,
} from '../erp/operations.js';
import { resolveDealOwners } from '../b24/deal-info.js';

/**
 * API окна «Складской учёт».
 *  - /api/stock/movements   — read-only журнал (списания/оприходования/реализации);
 *  - /api/stock/form-data   — справочники для форм создания (склады, поставщики, право);
 *  - /api/stock/search-items — поиск товаров каталога ядра (пикер позиций);
 *  - /api/stock/create      — создать ЧЕРНОВИК прихода/списания (Provести — отдельно);
 *  - /api/stock/submit      — провести черновик (двигает остатки ядра).
 * Перемещения — отдельный роут /api/transfers/*.
 * Авторизация — Б24-oauth (домен из allowlist). Создание/проведение — только канарейка.
 */
interface AuthBody { domain?: string; accessToken?: string }

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

/** Право создавать/проводить складские документы = канарейка окна (как BETA_USER_IDS на фронте).
 *  Сознательно НЕ пускаем рядовых: создание двигает остатки ядра. */
export const STOCK_CREATE_IDS = new Set(['1', '986', '1858']);

/** id текущего пользователя Б24 (для гейта создания). '' — не определён. */
async function currentUserId(client: B24Client): Promise<string> {
	const me = await client.call<{ ID?: string | number }>('user.current', {}).catch(() => null);
	return String(me?.ID ?? '');
}

/** Поставщики Б24 = CRM-компании в воронке «Поставщики» (складские контрагенты, code CATALOG_CONTRACTOR_COMPANY).
 *  Обычный crm.company.list их НЕ отдаёт (не дефолтная категория) — берём через универсальный crm.item.list. */
let supplierCatId: number | null = null;
async function supplierCategoryId(client: B24Client): Promise<number> {
	if (supplierCatId !== null) return supplierCatId;
	try {
		const r = await client.call<{ categories?: Array<{ id?: number; code?: string }> }>('crm.category.list', { entityTypeId: 4 });
		const cat = (r?.categories ?? []).find((c) => c.code === 'CATALOG_CONTRACTOR_COMPANY');
		supplierCatId = cat ? Number(cat.id) : 8;
	} catch { supplierCatId = 8; }
	return supplierCatId;
}

async function fetchSupplierCompanies(client: B24Client, log: FastifyInstance['log']): Promise<string[]> {
	const out: string[] = [];
	try {
		const categoryId = await supplierCategoryId(client);
		for (let start = 0; start < 2000; start += 50) {
			const r = await client.call<{ items?: Array<{ title?: string }> }>('crm.item.list', { entityTypeId: 4, filter: { categoryId }, select: ['id', 'title'], start });
			const items = r?.items ?? [];
			if (!items.length) break;
			for (const it of items) { const t = String(it.title ?? '').trim(); if (t) out.push(t); }
			if (items.length < 50) break;
		}
	} catch (e) {
		log.warn({}, `[api/stock] список поставщиков (воронка контрагентов) недоступен — ${errInfo(e)}`);
	}
	return [...new Set(out)].sort((a, b) => a.localeCompare(b, 'ru'));
}


/** Розничная цена в Б24 (тип «Розница» = catalogGroupId 2). Best-effort: обновляем, иначе добавляем; не бросаем. */
async function pushRetailToB24(client: B24Client, productId: number, price: number, log: FastifyInstance['log']): Promise<void> {
	if (!(price > 0)) return;
	try {
		const existing = await client.call<{ prices?: Array<{ id?: number }> }>('catalog.price.list', {
			filter: { productId, catalogGroupId: 2 }, select: ['id'],
		});
		const id = Number(existing?.prices?.[0]?.id ?? 0) || 0;
		if (id) {
			await client.call('catalog.price.update', { id, fields: { price, currency: 'RUB' } });
		} else {
			await client.call('catalog.price.add', { fields: { productId, catalogGroupId: 2, price, currency: 'RUB' } });
		}
	} catch (e) {
		log.warn({ productId }, `[api/stock] розница в Б24 не записана (best-effort) — ${errInfo(e)}`);
	}
}

interface ReceiptLine { productId: number; qty: number; purchase: number; retail: number }
interface IssueLine { productId: number; qty: number }

export function registerApiStockRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	// body: { domain, accessToken, kind: 'issue'|'receipt'|'delivery', from?, to? (YYYY-MM-DD) }
	app.post('/api/stock/movements', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { kind?: unknown; from?: unknown; to?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const kind = b.kind === 'receipt' ? 'receipt' : b.kind === 'delivery' ? 'delivery' : 'issue';
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
		const period: { from?: string; to?: string; productId?: number } = {};
		if (isDate(b.from)) period.from = b.from;
		if (isDate(b.to)) period.to = b.to;
		const pid = Number((b as { productId?: unknown }).productId);
		if (Number.isInteger(pid) && pid > 0) period.productId = pid;
		try {
			const movements = await listCoreMovements(erp, kind, period);
			const owners = await resolveDealOwners(client, movements.map((m) => m.dealId));
			return { ok: true, kind, movements: movements.map((m) => ({ ...m, ownerName: owners.get(m.dealId) ?? '' })) };
		} catch (e) {
			app.log.error({}, `[api/stock/movements] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Содержимое одного документа (раскрытие строки журнала). body: { doctype, name }
	app.post('/api/stock/doc', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { doctype?: unknown; name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const doctype = String(b.doctype ?? '').trim();
		const name = String(b.name ?? '').trim();
		if (!doctype || !name) return reply.code(400).send({ ok: false, error: 'нужны doctype и name' });
		try {
			const detail = await fetchCoreDocDetail(erp, doctype, name);
			const owners = await resolveDealOwners(client, [detail.dealId]);
			return { ok: true, detail: { ...detail, ownerName: owners.get(detail.dealId) ?? '' } };
		} catch (e) {
			app.log.error({}, `[api/stock/doc] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// История движений по товару (Stock Ledger Entry). body: { productId }
	app.post('/api/stock/item-history', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { productId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const productId = Number(b.productId);
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'bad productId' });
		try {
			return { ok: true, movements: await itemStockLedger(erp, productId) };
		} catch (e) {
			app.log.error({}, `[api/stock/item-history] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Справочники для форм: склады, поставщики, право создавать (канарейка).
	app.post('/api/stock/form-data', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const [stores, suppliers, uid] = await Promise.all([
				listActiveStoreTitles(erp), fetchSupplierCompanies(client, app.log), currentUserId(client),
			]);
			return { ok: true, stores, suppliers, canCreate: STOCK_CREATE_IDS.has(uid) };
		} catch (e) {
			app.log.error({}, `[api/stock/form-data] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Поиск товаров каталога ядра (по id / имени / артикулу) — пикер позиций в формах.
	app.post('/api/stock/search-items', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { q?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			return { ok: true, items: await searchErpItems(erp, String(b.q ?? '')) };
		} catch (e) {
			app.log.error({}, `[api/stock/search-items] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Создать НОВЫЙ товар (которого нет в каталоге): продукт в каталоге Б24 (iblock 24, простой, штуки)
	// → productId → зеркало Item в ядре. Возвращает {productId, name} для добавления в приход. Гейт — канарейка.
	app.post('/api/stock/create-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const name = String(b.name ?? '').trim();
		if (name.length < 2) return reply.code(400).send({ ok: false, error: 'имя товара слишком короткое' });
		try {
			if (!STOCK_CREATE_IDS.has(await currentUserId(client))) return reply.code(403).send({ ok: false, error: 'создавать товар может только канарейка' });
			// iblock 24 = базовый каталог CRM (productIblockId=null); type 1 = простой товар; measure 9 = штуки (дефолт портала).
			const r = await client.call<{ element?: { id?: number | string } }>('catalog.product.add', { fields: { iblockId: 24, name, type: 1, measure: 9, active: 'Y' } });
			const productId = Number(r?.element?.id ?? 0) || 0;
			if (!productId) throw new Error('catalog.product.add не вернул id');
			await ensureCoreItem(erp, { productId, name });
			app.log.info({ productId, name }, '[api/stock/create-product] ok');
			return { ok: true, productId, name };
		} catch (e) {
			app.log.error({}, `[api/stock/create-product] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Создать ЧЕРНОВИК: kind 'receipt' (Приход) | 'issue' (Списание). Перемещения — /api/transfers.
	app.post('/api/stock/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			if (!STOCK_CREATE_IDS.has(await currentUserId(client))) return reply.code(403).send({ ok: false, error: 'создавать складские документы может только канарейка' });
			const kind = b['kind'] === 'receipt' ? 'receipt' : b['kind'] === 'issue' ? 'issue' : null;
			if (!kind) return reply.code(400).send({ ok: false, error: 'kind должен быть receipt|issue' });

			if (kind === 'receipt') {
				const toStore = String(b['toStore'] ?? '').trim();
				if (!toStore) return reply.code(400).send({ ok: false, error: 'не выбран склад прихода' });
				const lines: ReceiptLine[] = (Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [])
					.map((l) => ({ productId: Number(l['productId']), qty: Number(l['qty']), purchase: Number(l['purchase'] ?? 0), retail: Number(l['retail'] ?? 0) }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
				if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций с количеством > 0' });
				const supplierIn = String(b['supplier'] ?? '').trim();
				const supplier = supplierIn ? await ensureSupplier(erp, supplierIn) : undefined;
				const note = String(b['note'] ?? '').trim();
				const { name } = await createReceiptDraft(erp, {
					...(supplier ? { supplier } : {}),
					...(note ? { note } : {}),
					lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, toStore, rate: l.purchase })),
				});
				// Розница → Б24 (best-effort, только заполненные). Запись розницы как мастер в ядро — следующий шаг.
				for (const l of lines.filter((x) => x.retail > 0)) await pushRetailToB24(client, l.productId, l.retail, app.log);
				app.log.info({ name, lines: lines.length }, '[api/stock/create] receipt draft');
				return { ok: true, kind, name };
			}

			// issue
			const fromStore = String(b['fromStore'] ?? '').trim();
			if (!fromStore) return reply.code(400).send({ ok: false, error: 'не выбран склад списания' });
			const reason = String(b['reason'] ?? '').trim();
			const note = String(b['note'] ?? '').trim();
			const lines: IssueLine[] = (Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [])
				.map((l) => ({ productId: Number(l['productId']), qty: Number(l['qty']) }))
				.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
			if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций с количеством > 0' });
			const { name } = await createWriteOffDraft(erp, {
				...(reason ? { reason } : {}),
				...(note ? { note } : {}),
				lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, fromStore })),
			});
			app.log.info({ name, lines: lines.length }, '[api/stock/create] issue draft');
			return { ok: true, kind, name };
		} catch (e) {
			app.log.error({}, `[api/stock/create] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Провести черновик: kind 'receipt' (Purchase Receipt) | 'issue' (Stock Entry).
	app.post('/api/stock/submit', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { kind?: unknown; name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const name = String(b.name ?? '').trim();
		if (!name) return reply.code(400).send({ ok: false, error: 'нет имени документа' });
		const doctype = b.kind === 'receipt' ? 'Purchase Receipt' : b.kind === 'issue' ? 'Stock Entry' : null;
		if (!doctype) return reply.code(400).send({ ok: false, error: 'kind должен быть receipt|issue' });
		try {
			if (!STOCK_CREATE_IDS.has(await currentUserId(client))) return reply.code(403).send({ ok: false, error: 'проводить может только канарейка' });
			await submitDoc(erp, doctype, name);
			app.log.info({ name, doctype }, '[api/stock/submit] ok');
			return { ok: true, name };
		} catch (e) {
			app.log.error({}, `[api/stock/submit] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});
}
