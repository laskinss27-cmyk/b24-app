import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { buildProductBase, type ProductBaseData } from '../b24/catalog.js';
import { ErpClient } from '../erp/client.js';
import {
	ensureCoreItem, fetchErpStocks, fetchErpStocksFor, fetchErpPurchasing,
	fetchCoreCatalogPrices, listActiveStoreTitles, updateCoreCatalogPrices,
} from '../erp/operations.js';
import { normalizeDomain } from '../security.js';

/**
 * API «Базы товаров» для фронта. Сборка каталога — на бэкенде (фронтовый BX24
 * виснет на catalog.product.list; объём ~2.5к позиций удобнее собрать серверно).
 *
 * Только ЧТЕНИЕ. Токен — самого юзера (BX24.getAuth), права Битрикса соблюдаются.
 * Домен сверяем с порталом (allowlist), как в api-inventory.
 *
 * КЭШ: сборка тяжёлая (~20с), поэтому держим её в памяти процесса с TTL. Повторные
 * открытия отдаются мгновенно. Кэш per-instance (serverless stateless — на каждый
 * контейнер свой), что для нашего трафика ок. force=true — принудительная пересборка.
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
	force?: boolean;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

const CACHE_TTL_MS = 5 * 60 * 1000;
interface CatalogStore {
	id: number;
	title: string;
	active: boolean;
}
interface CacheEntry {
	data: ProductBaseData;
	stores: CatalogStore[];
	expires: number;
}
const baseCache = new Map<string, CacheEntry>();

export function invalidateCatalogCache(domain: string): void {
	baseCache.delete(normalizeDomain(domain));
}

const SUPPLY_DEPARTMENT_ID = 10;

interface CatalogCandidate {
	id: number;
	iblockId: number;
	name: string;
	isService: boolean;
	article?: string;
	model?: string;
	manufacturer?: string;
	sectionId?: number;
	sectionName?: string;
	retail: number | null;
	purchase: number | null;
	total: number;
	stockByStore: Record<number, number>;
}

function cleanText(value: unknown): string {
	return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalized(value: unknown): string {
	return cleanText(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '');
}

function normalizedStoreTitle(value: unknown): string {
	return cleanText(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

async function canEditCatalogPrices(client: B24Client): Promise<boolean> {
	const me = await client.call<{ NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: unknown }>('user.current', {}).catch(() => null);
	const departments = Array.isArray(me?.UF_DEPARTMENT) ? (me.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const isKonstantinLaskin = normalized(me?.NAME) === normalized('Константин')
		&& normalized(me?.LAST_NAME) === normalized('Ласкин');
	return departments.includes(SUPPLY_DEPARTMENT_ID) || isKonstantinLaskin;
}

function productTitle(productType: string, manufacturer: string, model: string): string {
	return [productType, manufacturer, model].map(cleanText).filter(Boolean).join(' ');
}

function propValue(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const raw = obj['valueEnum'] ?? obj['value'];
		return raw == null || raw === '' ? undefined : cleanText(raw);
	}
	const text = cleanText(value);
	return text || undefined;
}

function candidateScore(row: CatalogCandidate, args: { name: string; model: string; manufacturer: string }): { score: number; exact: boolean } {
	const wantedModel = normalized(args.model);
	const wantedBrand = normalized(args.manufacturer);
	const rowModel = normalized(row.article || row.model);
	const rowBrand = normalized(row.manufacturer);
	const exactName = normalized(row.name) === normalized(args.name);
	const exactModel = Boolean(wantedModel && rowModel === wantedModel);
	if (exactName || exactModel) return { score: 100, exact: true };
	let score = 0;
	if (wantedModel && rowModel === wantedModel) score += 70;
	else if (wantedModel && (normalized(row.name).includes(wantedModel) || wantedModel.includes(rowModel))) score += 45;
	if (wantedBrand && rowBrand === wantedBrand) score += 20;
	else if (wantedBrand && normalized(row.name).includes(wantedBrand)) score += 10;
	const wantedTokens = cleanText(args.name).toLocaleLowerCase('ru-RU').split(/[^a-zа-я0-9]+/i).filter((token) => token.length > 1);
	const rowName = cleanText(row.name).toLocaleLowerCase('ru-RU');
	const overlap = wantedTokens.filter((token) => rowName.includes(token)).length;
	if (wantedTokens.length) score += Math.round(20 * overlap / wantedTokens.length);
	return { score, exact: false };
}

function rankedCandidates(rows: CatalogCandidate[], args: { name: string; model: string; manufacturer: string }): Array<CatalogCandidate & { exact: boolean }> {
	return rows
		.filter((row) => !row.isService)
		.map((row) => ({ row, ...candidateScore(row, args) }))
		.filter((entry) => entry.score >= 45)
		.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name, 'ru'))
		.slice(0, 8)
		.map(({ row, exact }) => ({ ...row, exact }));
}

async function freshExactCandidates(client: B24Client, args: { name: string; model: string }): Promise<CatalogCandidate[]> {
	const select = ['id', 'iblockId', 'name', 'type', 'property334', 'property330', 'iblockSectionId', 'purchasingPrice'];
	const attempts = await Promise.allSettled([
		client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', { filter: { iblockId: 24, name: args.name }, select }),
		client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', { filter: { iblockId: 24, property330: args.model }, select }),
	]);
	const byId = new Map<number, CatalogCandidate>();
	for (const attempt of attempts) {
		if (attempt.status !== 'fulfilled') continue;
		for (const product of attempt.value?.products ?? []) {
			const id = Number(product['id']);
			if (!(id > 0)) continue;
			const model = propValue(product['property330']);
			const manufacturer = propValue(product['property334']);
			const sectionId = Number(product['iblockSectionId'] ?? 0) || undefined;
			byId.set(id, {
				id,
				iblockId: Number(product['iblockId'] ?? 24),
				name: cleanText(product['name']) || `#${id}`,
				isService: Number(product['type']) === 7,
				...(model ? { model } : {}),
				...(manufacturer ? { manufacturer } : {}),
				...(sectionId ? { sectionId } : {}),
				retail: null,
				purchase: Number(product['purchasingPrice'] ?? 0) || null,
				total: 0,
				stockByStore: {},
			});
		}
	}
	const candidates = [...byId.values()];
	if (candidates.length) {
		try {
			const prices = await client.call<{ prices?: Array<Record<string, unknown>> }>('catalog.price.list', {
				filter: { productId: candidates.map((candidate) => candidate.id), catalogGroupId: 2 },
				select: ['productId', 'price'],
			});
			const priceById = new Map((prices?.prices ?? []).map((price) => [Number(price['productId']), Number(price['price'])]));
			for (const candidate of candidates) candidate.retail = priceById.get(candidate.id) ?? null;
		} catch { /* Цена не нужна для самой блокировки дубля. */ }
	}
	return candidates;
}

let createProductQueue: Promise<void> = Promise.resolve();
async function serializeProductCreate<T>(action: () => Promise<T>): Promise<T> {
	const previous = createProductQueue;
	let release!: () => void;
	createProductQueue = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	try { return await action(); } finally { release(); }
}

export function registerApiCatalogRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	app.post('/api/catalog/browse', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const canEditPrices = await canEditCatalogPrices(client);
		const cacheKey = normalizeDomain(body.domain ?? '');
		const now = Date.now();
		const hit = baseCache.get(cacheKey);
		if (!body.force && hit && hit.expires > now) {
			app.log.info({ rows: hit.data.rows.length, cached: true }, '[api/catalog/browse] cache hit');
			return { ok: true, rows: hit.data.rows, stores: hit.stores, generatedAt: hit.data.generatedAt, cached: true, canEditPrices };
		}

		const t0 = Date.now();
		try {
			const [data, storeRes] = await Promise.all([
				buildProductBase(client),
				client.call<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', {
					select: ['id', 'title', 'active'],
					order: { id: 'ASC' },
				}),
			]);
			const stores: CatalogStore[] = (storeRes?.stores ?? [])
				.map((store) => ({
					id: Number(store['id']),
					title: String(store['title'] ?? '').trim(),
					active: store['active'] === 'Y',
				}))
				.filter((store) => Number.isInteger(store.id) && store.id > 0 && store.title && store.active);
			// Остатки из ЯДРА (как во вкладке сделки): подменяем Б24-остатки ядерными, если ядро подключено.
			// Склады, живущие только в ядре (например Shelly и Маркетплейс), получают служебные
			// отрицательные ID: они нужны лишь фронту для фильтра и обратно уходят по названию.
			// Ядро недоступно/ошибка → молча оставляем остатки Б24 (мягкий фолбэк). Радиус — только «База» (канарейка).
			let stockSource = 'b24';
			const erp = ErpClient.fromEnv();
			if (erp) {
				try {
					const [coreStocks, corePrices, coreStoreTitles] = await Promise.all([
						fetchErpStocks(erp),
						fetchCoreCatalogPrices(erp),
						listActiveStoreTitles(erp),
					]);
					const titleToId = new Map(stores.map((store) => [normalizedStoreTitle(store.title), store.id]));
					let virtualStoreId = -1;
					for (const title of coreStoreTitles) {
						const key = normalizedStoreTitle(title);
						if (titleToId.has(key)) continue;
						stores.push({ id: virtualStoreId, title, active: true });
						titleToId.set(key, virtualStoreId);
						virtualStoreId -= 1;
					}
					for (const r of data.rows) {
						const byTitle = coreStocks.get(r.id);
						const byStore: Record<number, number> = {};
						if (byTitle) {
							for (const [title, qty] of Object.entries(byTitle)) {
								const sid = titleToId.get(normalizedStoreTitle(title));
								if (sid != null) byStore[sid] = (byStore[sid] ?? 0) + qty;
							}
						}
						r.stockByStore = byStore;
						r.total = Object.values(byStore).reduce((a, b) => a + b, 0);
						const prices = corePrices.get(r.id);
						if (prices?.retail !== undefined) r.retail = prices.retail;
						if (prices?.purchase !== undefined) r.purchase = prices.purchase;
					}
					stockSource = 'core';
				} catch (e) {
					app.log.warn({}, `[api/catalog/browse] ядро недоступно — остатки из Б24 (фолбэк): ${errInfo(e)}`);
				}
			}
			stores.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
			baseCache.set(cacheKey, { data, stores, expires: now + CACHE_TTL_MS });
			app.log.info({ rows: data.rows.length, ms: Date.now() - t0, cached: false, stock: stockSource }, '[api/catalog/browse] ok');
			return { ok: true, rows: data.rows, stores, generatedAt: data.generatedAt, cached: false, canEditPrices };
		} catch (err) {
			app.log.error({ ms: Date.now() - t0 }, `[api/catalog/browse] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/catalog/update-prices', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!(await canEditCatalogPrices(client))) {
			return reply.code(403).send({ ok: false, error: 'редактирование цен доступно снабжению и Константину Ласкину' });
		}
		const productId = Number(body['productId']);
		const retail = Number(body['retail']);
		const purchase = Number(body['purchase']);
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'неверный ID товара' });
		if (!Number.isFinite(retail) || retail < 0) return reply.code(400).send({ ok: false, error: 'розничная цена должна быть 0 или больше' });
		if (!Number.isFinite(purchase) || purchase < 0) return reply.code(400).send({ ok: false, error: 'закупочная цена должна быть 0 или больше' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			await updateCoreCatalogPrices(erp, { productId, retail, purchase });
			baseCache.delete(normalizeDomain(body.domain ?? ''));
			app.log.info({ productId, retail, purchase }, '[api/catalog/update-prices] ok');
			return { ok: true, productId, retail, purchase };
		} catch (error) {
			app.log.error({ productId }, `[api/catalog/update-prices] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/catalog/create-product', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });

		const productType = cleanText(body['productType']);
		const manufacturer = cleanText(body['manufacturer']);
		const model = cleanText(body['model']);
		const sectionId = Number(body['sectionId']);
		const sectionNameInput = cleanText(body['sectionName']);
		const retail = Number(body['retail']);
		const similarReviewed = body['similarReviewed'] === true;
		if (productType.length < 3) return reply.code(400).send({ ok: false, error: 'укажи вид товара' });
		if (manufacturer.length < 2) return reply.code(400).send({ ok: false, error: 'укажи производителя' });
		if (model.length < 2) return reply.code(400).send({ ok: false, error: 'укажи полную модель или артикул' });
		if (!Number.isInteger(sectionId) || sectionId <= 0) return reply.code(400).send({ ok: false, error: 'выбери раздел каталога' });
		if (!(retail > 0)) return reply.code(400).send({ ok: false, error: 'цена продажи должна быть больше нуля' });

		const name = productTitle(productType, manufacturer, model);
		const cacheKey = normalizeDomain(body.domain ?? '');
		try {
			return await serializeProductCreate(async () => {
				const cachedRows = (baseCache.get(cacheKey)?.data.rows ?? []) as CatalogCandidate[];
				const sectionName = cachedRows.find((row) => row.sectionId === sectionId)?.sectionName || sectionNameInput;
				const fresh = await freshExactCandidates(client, { name, model });
				const merged = new Map<number, CatalogCandidate>();
				for (const row of [...cachedRows, ...fresh]) merged.set(row.id, row);
				const candidates = rankedCandidates([...merged.values()], { name, model, manufacturer });
				const exact = candidates.filter((candidate) => candidate.exact);
				if (exact.length) return { ok: true, status: 'duplicate', name, candidates: exact };
				if (candidates.length && !similarReviewed) return { ok: true, status: 'review', name, candidates };

				let productId = 0;
				try {
					const created = await client.call<{ element?: { id?: number | string } }>('catalog.product.add', {
						fields: {
							iblockId: 24,
							name,
							type: 1,
							measure: 9,
							active: 'Y',
							iblockSectionId: sectionId,
							property334: manufacturer,
							property330: model,
						},
					});
					productId = Number(created?.element?.id ?? 0) || 0;
					if (!productId) throw new Error('catalog.product.add не вернул id');
					await ensureCoreItem(erp, { productId, name, model, article: model, brand: manufacturer, section: sectionName });
					await updateCoreCatalogPrices(erp, { productId, retail, purchase: 0 });
				} catch (error) {
					if (productId) await client.call('catalog.product.delete', { id: productId }).catch(() => undefined);
					throw error;
				}

				baseCache.delete(cacheKey);
				const row: CatalogCandidate = {
					id: productId,
					iblockId: 24,
					name,
					isService: false,
					model,
					manufacturer,
					sectionId,
					sectionName,
					retail,
					purchase: null,
					total: 0,
					stockByStore: {},
				};
				app.log.info({ productId, name, sectionId }, '[api/catalog/create-product] ok');
				return { ok: true, status: 'created', name, product: row };
			});
		} catch (error) {
			app.log.error({}, `[api/catalog/create-product] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	// Остатки из ЯДРА (ERPNext) — payoff выноса склада: один запрос Bin вместо BX24 catalog.storeproduct.
	// Ядро = зеркало остатков Б24 (сверка-в-ноль), поэтому подмена прозрачна; закупка — из valuation_rate.
	// Гейт env ERPNEXT_URL: ядро не подключено → coreOff, фронт мягко падает на Б24 (fetchStockAndPurchasing).
	// Склады отдаём ПО ИМЕНИ — фронт маппит в storeId по списку складов Б24.
	app.post('/api/catalog/erp-stocks', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { productIds?: unknown };
		if (!body.domain || normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) {
			return reply.code(403).send({ ok: false, error: 'bad domain' });
		}
		const ids = (Array.isArray(body.productIds) ? body.productIds : [])
			.map(Number).filter((n) => Number.isInteger(n) && n > 0);
		if (!ids.length) return { ok: true, byProduct: {} };
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, coreOff: true, error: 'ядро не подключено (ERPNEXT_URL)' });
		try {
			// ТОЛЬКО запрошенные товары (item_code in) — полный Bin через мост не лезет в 60с (выстрадано 2026-06-15).
			const [stocks, purchasing] = await Promise.all([
				fetchErpStocksFor(erp, ids),
				fetchErpPurchasing(erp, ids),
			]);
			// Возвращаем КАЖДЫЙ запрошенный товар (даже с нулём — чтобы не потерять закупку у бесстоковых).
			const byProduct: Record<number, { stocks: Record<string, number>; purchasing: number }> = {};
			for (const pid of ids) byProduct[pid] = { stocks: stocks.get(pid) ?? {}, purchasing: purchasing.get(pid) ?? 0 };
			app.log.info({ products: Object.keys(byProduct).length }, '[api/catalog/erp-stocks] ok');
			return { ok: true, byProduct };
		} catch (err) {
			app.log.error({}, `[api/catalog/erp-stocks] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
