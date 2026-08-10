import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { buildProductBase, type ProductBaseData } from '../b24/catalog.js';
import { ErpClient } from '../erp/client.js';
import {
	ensureCoreItem, fetchErpStocks, fetchErpStocksFor, fetchErpPurchasing,
	fetchCoreCatalogItems, fetchCoreCatalogPrices, listActiveStoreTitles,
	coreStoreId, updateCoreCatalogPrices, updateMarketplaceOldId,
} from '../erp/operations.js';
import { createCatalogComparisonWorkbook } from '../catalog-comparison-xlsx.js';
import { createMarketplaceCatalogWorkbook } from '../marketplace-catalog-xlsx.js';
import { normalizeDomain } from '../security.js';
import { canonicalProductId } from '../product-aliases.js';
import {
	applyCatalogContentEdits,
	createCatalogContent,
	parseCatalogContent,
	renderCatalogDescription,
	serializeFilterAttributes,
	type CatalogProductContent,
} from '../catalog-content.js';
import { splitCatalogProductNameStatus } from '../catalog-product-status.js';
import { appPermission } from '../access-policy.js';
import type {
	AuthBody,
	CatalogCandidate,
	CatalogStore,
	CoreProductBaseRow,
} from './api-catalog-types.js';
import {
	canEditCatalogPrices,
	canExportCatalogComparison,
	catalogAccess,
	catalogClientFrom,
	errInfo,
} from './api-catalog-route-helpers.js';
import { baseCache, CACHE_TTL_MS } from './api-catalog-cache.js';

export { invalidateCatalogCache } from './api-catalog-cache.js';

/**
 * API «Базы товаров» для фронта. Сборка каталога — на бэкенде (фронтовый BX24
 * виснет на catalog.product.list; объём ~2.5к позиций удобнее собрать серверно).
 *
 * Только ЧТЕНИЕ. Токен — самого юзера (BX24.getAuth), права Битрикса соблюдаются.
 * Домен сверяем с порталом (allowlist), как в api-inventory.
 *
 * КЭШ: сборка тяжёлая (~20с), поэтому держим её в памяти процесса с TTL. Повторные
 * открытия отдаются мгновенно. Кэш хранится в памяти конкретного контейнера;
 * force=true запускает принудительную пересборку.
 */
function cleanText(value: unknown): string {
	return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function cleanMultiline(value: unknown): string {
	return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, 10_000);
}

const CATALOG_PHOTO_MAX_BYTES = 800 * 1024;
const CATALOG_PHOTO_TYPES = new Map([
	['image/jpeg', { extension: 'jpg', signature: (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
	['image/png', { extension: 'png', signature: (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
	['image/webp', { extension: 'webp', signature: (bytes: Buffer) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' }],
] as const);

function catalogPhoto(value: unknown): { fileName: string; mimeType: string; content: Buffer } | null {
	if (value == null || value === '') return null;
	if (!value || typeof value !== 'object') throw new Error('сервер получил неверное фото товара');
	const row = value as Record<string, unknown>;
	const mimeType = cleanText(row['mimeType']).toLocaleLowerCase('en-US');
	const kind = CATALOG_PHOTO_TYPES.get(mimeType as 'image/jpeg' | 'image/png' | 'image/webp');
	if (!kind) throw new Error('фото должно быть в формате JPEG, PNG или WebP');
	const encoded = String(row['content'] ?? '').replace(/^data:[^,]*,/u, '').trim();
	if (!encoded || !/^[a-z0-9+/]+={0,2}$/iu.test(encoded)) throw new Error('фото товара повреждено');
	const content = Buffer.from(encoded, 'base64');
	if (!content.length || !kind.signature(content)) throw new Error('содержимое фото не соответствует его формату');
	if (content.length > CATALOG_PHOTO_MAX_BYTES) {
		throw new Error(`фото после подготовки должно весить не больше ${Math.round(CATALOG_PHOTO_MAX_BYTES / 1024)} КБ`);
	}
	const original = cleanText(row['fileName']).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 70);
	const stem = original.replace(/\.[^.]+$/u, '').trim() || 'product';
	return { fileName: `${stem}.${kind.extension}`, mimeType, content };
}

function normalized(value: unknown): string {
	return cleanText(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '');
}

function normalizedStoreTitle(value: unknown): string {
	return cleanText(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

function coreSectionId(title: string): number {
	return Math.abs(coreStoreId(`section:${title}`));
}

async function buildCoreProductBase(erp: ErpClient, metadata: ProductBaseData): Promise<{
	data: { rows: CoreProductBaseRow[]; generatedAt: string };
	stores: CatalogStore[];
}> {
	const [items, stocks, prices, storeTitles] = await Promise.all([
		fetchCoreCatalogItems(erp),
		fetchErpStocks(erp),
		fetchCoreCatalogPrices(erp),
		listActiveStoreTitles(erp),
	]);
	const stores = storeTitles.map((title) => ({ id: coreStoreId(title), title, active: true }));
	const storeIdByTitle = new Map(stores.map((store) => [normalizedStoreTitle(store.title), store.id]));
	const metadataById = new Map(metadata.rows.map((row) => [row.id, row]));
	const rows = items.map((item) => {
		const known = metadataById.get(item.productId);
		const stockByStore: Record<number, number> = {};
		for (const [title, qty] of Object.entries(stocks.get(item.productId) ?? {})) {
			const storeId = storeIdByTitle.get(normalizedStoreTitle(title));
			if (storeId != null) stockByStore[storeId] = (stockByStore[storeId] ?? 0) + qty;
		}
		const corePrices = prices.get(item.productId);
		const sectionName = item.section || known?.sectionName;
		const photoPath = item.image
			? `/api/inventory/erp-image?p=${encodeURIComponent(item.image)}`
			: known?.photoPath;
		return {
			id: item.productId,
			iblockId: known?.iblockId ?? 24,
			name: item.name || known?.name || `#${item.productId}`,
			isService: item.isService,
			isMarketplaceBundle: item.isMarketplaceBundle,
			article: item.article || known?.article,
			model: item.model || known?.model,
			manufacturer: item.manufacturer || known?.manufacturer,
			sectionId: known?.sectionId ?? (sectionName ? coreSectionId(sectionName) : undefined),
			sectionName,
			status: item.status || known?.status,
			description: item.description || known?.description,
			...(item.content ? { content: item.content } : {}),
			filterCategory: item.filterCategory,
			marketplaceOldId: item.marketplaceOldId,
			retail: corePrices?.retail ?? known?.retail ?? null,
			purchase: corePrices?.purchase ?? known?.purchase ?? null,
			photoPath,
			total: Object.values(stockByStore).reduce((sum, qty) => sum + qty, 0),
			stockByStore,
		};
	});
	rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
	stores.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
	return { data: { rows, generatedAt: new Date().toISOString() }, stores };
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

function rankedCandidates(rows: CatalogCandidate[], args: { name: string; model: string; manufacturer: string; isService: boolean }): Array<CatalogCandidate & { exact: boolean }> {
	return rows
		.filter((row) => row.isService === args.isService)
		.map((row) => ({ row, ...candidateScore(row, args) }))
		.filter((entry) => entry.score >= 45)
		.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name, 'ru'))
		.slice(0, 8)
		.map(({ row, exact }) => ({ ...row, exact }));
}

async function freshExactCandidates(client: B24Client, args: { name: string; model: string }): Promise<CatalogCandidate[]> {
	const select = ['id', 'iblockId', 'name', 'type', 'property334', 'property330', 'iblockSectionId', 'purchasingPrice'];
	const requests = [
		client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', { filter: { iblockId: 24, name: args.name }, select }),
		...(args.model ? [client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', { filter: { iblockId: 24, property330: args.model }, select })] : []),
	];
	const attempts = await Promise.allSettled(requests);
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
	const clientFrom = (body: AuthBody): B24Client | null => catalogClientFrom(app, body);

	app.post('/api/catalog/stores', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const titles = await listActiveStoreTitles(erp);
			return {
				ok: true,
				stores: titles.map((title) => ({ id: coreStoreId(title), title, active: true })),
			};
		} catch (error) {
			app.log.error(`[api/catalog/stores] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/catalog/browse', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const legacyAccess = await catalogAccess(client);
		const canEditPrices = appPermission(req, 'catalog.edit_retail_prices', legacyAccess.canEditPrices)
			&& appPermission(req, 'catalog.edit_purchase_prices', legacyAccess.canEditPrices);
		const canEditCard = appPermission(req, 'catalog.edit_card', legacyAccess.canEditCard);
		const canViewPurchasePrices = appPermission(req, 'catalog.view_purchase_prices', true);
		const marketplaceMode = body.marketplaceMode === true;
		const canEditMarketplaceOldId = marketplaceMode && (
			appPermission(req, 'supply.view', legacyAccess.canEditPrices || legacyAccess.canEditCard)
			|| appPermission(req, 'marketplaces.view', legacyAccess.canEditCard)
		);
		const cacheKey = normalizeDomain(body.domain ?? '');
		const now = Date.now();
		const hit = baseCache.get(cacheKey);
		const t0 = Date.now();
		try {
			const erp = ErpClient.fromEnv();
			if (!erp) throw new Error('ядро склада не подключено (ERPNEXT_URL)');
			const cached = !body.force && Boolean(hit && hit.expires > now);
			let metadata = cached && hit ? hit.data : null;
			if (!metadata) {
				try {
					metadata = await buildProductBase(client);
				} catch (error) {
					app.log.warn(`[api/catalog/browse] метаданные каталога Б24 недоступны: ${errInfo(error)}`);
					metadata = { rows: [], generatedAt: new Date().toISOString() };
				}
				baseCache.set(cacheKey, { data: metadata, expires: now + CACHE_TTL_MS });
			}
			const { data, stores } = await buildCoreProductBase(erp, metadata);
			app.log.info({ rows: data.rows.length, ms: Date.now() - t0, cached, source: 'core' }, '[api/catalog/browse] ok');
			const pricedRows = canViewPurchasePrices
				? data.rows
				: data.rows.map((row) => ({ ...row, purchase: null }));
			const rows = marketplaceMode
				? pricedRows
				: pricedRows.map(({ marketplaceOldId: _marketplaceOldId, ...row }) => row);
			return {
				ok: true,
				rows,
				stores,
				generatedAt: data.generatedAt,
				cached,
				canEditCard,
				canEditPrices,
				canEditMarketplaceOldId,
			};
		} catch (err) {
			app.log.error({ ms: Date.now() - t0 }, `[api/catalog/browse] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/catalog/export-comparison', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!appPermission(req, 'catalog.export_comparison', await canExportCatalogComparison(client))) {
			return reply.code(403).send({ ok: false, error: 'сверка каталога недоступна для текущего пользователя' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		const startedAt = Date.now();
		try {
			const metadata = await buildProductBase(client);
			const [coreRows, coreStocks] = await Promise.all([
				fetchCoreCatalogItems(erp),
				fetchErpStocks(erp),
			]);
			const createdAt = new Date();
			const workbook = createCatalogComparisonWorkbook({
				b24Rows: metadata.rows,
				coreRows,
				coreStocks,
				createdAt,
			});
			const xlsx = await workbook.xlsx.writeBuffer();
			const date = createdAt.toISOString().slice(0, 10);
			baseCache.set(normalizeDomain(body.domain ?? ''), {
				data: metadata,
				expires: Date.now() + CACHE_TTL_MS,
			});
			app.log.info({
				b24Rows: metadata.rows.length,
				coreRows: coreRows.length,
				ms: Date.now() - startedAt,
			}, '[api/catalog/export-comparison] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
				.header('Content-Disposition', `attachment; filename="catalog-comparison-${date}.xlsx"`)
				.send(Buffer.from(xlsx));
		} catch (error) {
			app.log.error({ ms: Date.now() - startedAt }, `[api/catalog/export-comparison] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/catalog/export-marketplace-selection', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const legacyAccess = await catalogAccess(client);
		const canExport = body.marketplaceMode === true && (
			appPermission(req, 'supply.view', legacyAccess.canEditPrices || legacyAccess.canEditCard)
			|| appPermission(req, 'marketplaces.view', legacyAccess.canEditCard)
		);
		if (!canExport) {
			return reply.code(403).send({ ok: false, error: 'выгрузка доступна только в разделе маркетплейсов' });
		}
		const productIds = [...new Set((Array.isArray(body['productIds']) ? body['productIds'] : [])
			.map(Number)
			.filter((value) => Number.isInteger(value) && value > 0))]
			.slice(0, 10_000);
		const storeIds = new Set((Array.isArray(body['storeIds']) ? body['storeIds'] : [])
			.map(Number)
			.filter((value) => Number.isInteger(value) && value > 0));
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		const startedAt = Date.now();
		try {
			const { data, stores } = await buildCoreProductBase(erp, { rows: [], generatedAt: '' });
			const byId = new Map(data.rows.map((row) => [row.id, row]));
			const canViewPurchasePrices = appPermission(req, 'catalog.view_purchase_prices', true);
			const rows = productIds
				.map((id) => byId.get(id))
				.filter((row): row is CoreProductBaseRow => Boolean(row))
				.map((row) => canViewPurchasePrices ? row : { ...row, purchase: null });
			const selectedStores = stores.filter((store) => storeIds.has(store.id));
			const createdAt = new Date();
			const workbook = createMarketplaceCatalogWorkbook({
				rows,
				stores: selectedStores,
				selectedStoreLabel: cleanText(body['selectedStoreLabel']).slice(0, 500),
				selectedSectionLabel: cleanText(body['selectedSectionLabel']).slice(0, 500),
				search: cleanText(body['search']).slice(0, 500),
				onlyStock: body['onlyStock'] === true,
				createdAt,
			});
			const xlsx = await workbook.xlsx.writeBuffer();
			const date = createdAt.toISOString().slice(0, 10);
			app.log.info({
				rows: rows.length,
				stores: selectedStores.length,
				ms: Date.now() - startedAt,
			}, '[api/catalog/export-marketplace-selection] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
				.header('Content-Disposition', `attachment; filename="marketplace-products-${date}.xlsx"`)
				.send(Buffer.from(xlsx));
		} catch (error) {
			app.log.error({ ms: Date.now() - startedAt }, `[api/catalog/export-marketplace-selection] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/catalog/update-prices', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const legacyCanEditPrices = await canEditCatalogPrices(client);
		if (
			!appPermission(req, 'catalog.edit_retail_prices', legacyCanEditPrices)
			|| !appPermission(req, 'catalog.edit_purchase_prices', legacyCanEditPrices)
		) {
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

	app.post('/api/catalog/update-marketplace-old-id', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const legacyAccess = await catalogAccess(client);
		const canEdit = appPermission(req, 'supply.view', legacyAccess.canEditPrices || legacyAccess.canEditCard)
			|| appPermission(req, 'marketplaces.view', legacyAccess.canEditCard);
		if (!canEdit) {
			return reply.code(403).send({ ok: false, error: 'поле «Старый ID» доступно только в разделе маркетплейсов' });
		}
		const productId = Number(body['productId']);
		const oldId = String(body['oldId'] ?? '').trim();
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'неверный ID товара' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const marketplaceOldId = await updateMarketplaceOldId(erp, { productId, oldId });
			app.log.info({ productId, marketplaceOldId }, '[api/catalog/update-marketplace-old-id] ok');
			return { ok: true, productId, marketplaceOldId };
		} catch (error) {
			app.log.error({ productId }, `[api/catalog/update-marketplace-old-id] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/catalog/update-product', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const legacyAccess = await catalogAccess(client);
		const canEditCard = appPermission(req, 'catalog.edit_card', legacyAccess.canEditCard);
		const canEditRetailPrice = appPermission(req, 'catalog.edit_retail_prices', legacyAccess.canEditPrices);
		const canEditPurchasePrice = appPermission(req, 'catalog.edit_purchase_prices', legacyAccess.canEditPrices);
		if (!canEditCard) {
			return reply.code(403).send({ ok: false, error: 'нет права редактировать карточку товара' });
		}
		const productId = Number(body['productId']);
		const iblockId = Number(body['iblockId']);
		const name = cleanText(body['name']);
		const manufacturer = cleanText(body['manufacturer']);
		const model = cleanText(body['model']);
		const article = cleanText(body['article']);
		const sectionId = Number(body['sectionId']);
		const sectionName = cleanText(body['sectionName']);
		const description = cleanMultiline(body['description']);
		const status = cleanText(body['status']);
		const retail = Number(body['retail']);
		const purchase = Number(body['purchase']);
		const isService = body['isService'] === true;
		let photo: ReturnType<typeof catalogPhoto>;
		try {
			photo = catalogPhoto(body['photo']);
		} catch (error) {
			return reply.code(400).send({ ok: false, error: errInfo(error) });
		}
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'неверный ID товара' });
		if (iblockId !== 24 && iblockId !== 26) return reply.code(400).send({ ok: false, error: 'неверный каталог товара' });
		if (name.length < 3) return reply.code(400).send({ ok: false, error: 'название товара должно быть не короче трёх символов' });
		if (splitCatalogProductNameStatus(name).hasInlineStatus) {
			return reply.code(400).send({
				ok: false,
				error: 'статус товара нужно выбирать отдельно, а не вписывать в название',
			});
		}
		if (!Number.isInteger(sectionId) || sectionId <= 0 || !sectionName) return reply.code(400).send({ ok: false, error: 'выбери раздел каталога' });
		if (!Number.isFinite(retail) || retail < 0) return reply.code(400).send({ ok: false, error: 'розничная цена должна быть 0 или больше' });
		if (!Number.isFinite(purchase) || purchase < 0) return reply.code(400).send({ ok: false, error: 'закупочная цена должна быть 0 или больше' });
		const allowedStatuses = new Set([
			'После ремонта', 'Снят с производства', 'Недоступен к заказу', 'К удалению',
			'Уценка', 'Витринный', 'Б/у', 'Распродажа', 'Повреждённый',
			'Некондиция', 'Демо', 'Образец', 'Сток',
		]);
		const statuses = status.split(',').map(cleanText).filter(Boolean);
		if (statuses.some((value) => !allowedStatuses.has(value)) || new Set(statuses).size !== statuses.length) {
			return reply.code(400).send({ ok: false, error: 'выбран неизвестный или повторяющийся статус товара' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		let before: Record<string, unknown> | null = null;
		let beforePrices: { retail?: number; purchase?: number } | undefined;
		let metadataChanged = false;
		let uploadedFileName = '';
		try {
			before = await erp.get<Record<string, unknown>>('Item', String(productId));
			if (!before) return reply.code(404).send({ ok: false, error: 'товар не найден в ядре' });
			const currentContent = parseCatalogContent(before['b24_catalog_content'])
				?? createCatalogContent(before['description'], []);
			const content = applyCatalogContentEdits(currentContent, body['summary'], body['attributeEdits']);
			const renderedDescription = renderCatalogDescription(content);
			if (description && description !== renderedDescription) {
				return reply.code(400).send({ ok: false, error: 'описание должно формироваться из структурированных полей' });
			}
			const category = cleanText(before['b24_filter_category']);
			beforePrices = (await fetchCoreCatalogPrices(erp)).get(productId);
			const nextRetail = canEditRetailPrice ? retail : beforePrices?.retail ?? 0;
			const nextPurchase = canEditPurchasePrice ? purchase : beforePrices?.purchase ?? 0;
			await erp.update('Item', String(productId), {
				item_name: name.slice(0, 140),
				is_stock_item: isService ? 0 : 1,
				b24_model: model,
				b24_article: article,
				b24_brand: manufacturer,
				b24_section: sectionName,
				b24_product_status: statuses.join(', '),
				description: renderedDescription,
				b24_catalog_content: JSON.stringify(content),
				b24_filter_attributes: serializeFilterAttributes(content, category),
				b24_filter_schema_version: '1',
				b24_filter_updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
			});
			metadataChanged = true;
			let photoPath = '';
			if (photo) {
				const uploaded = await erp.uploadPublicFile({
					fileName: photo.fileName,
					mimeType: photo.mimeType,
					content: photo.content,
					doctype: 'Item',
					docname: String(productId),
					fieldname: 'image',
				});
				uploadedFileName = uploaded.name;
				photoPath = uploaded.fileUrl;
				await erp.update('Item', String(productId), { image: uploaded.fileUrl });
			}
			if (canEditRetailPrice || canEditPurchasePrice) {
				await updateCoreCatalogPrices(erp, { productId, retail: nextRetail, purchase: nextPurchase });
			}
			baseCache.delete(normalizeDomain(body.domain ?? ''));
			app.log.info({ productId, iblockId }, '[api/catalog/update-product] ok');
			return {
				ok: true,
				product: {
					id: productId,
					iblockId,
					name,
					isService,
					article,
					model,
					manufacturer,
					sectionId,
					sectionName,
					status: statuses.join(', '),
					description: renderedDescription,
					content,
					retail: nextRetail,
					purchase: nextPurchase,
					...(photoPath ? { photoPath: `/api/inventory/erp-image?p=${encodeURIComponent(photoPath)}` } : {}),
				},
			};
		} catch (error) {
			if (uploadedFileName) await erp.delete('File', uploadedFileName).catch(() => undefined);
			if (metadataChanged && before) {
				try {
					await erp.update('Item', String(productId), {
						item_name: before['item_name'],
						is_stock_item: before['is_stock_item'],
						b24_model: before['b24_model'],
						b24_article: before['b24_article'],
						b24_brand: before['b24_brand'],
						b24_section: before['b24_section'],
						b24_product_status: before['b24_product_status'],
						description: before['description'],
						b24_catalog_content: before['b24_catalog_content'],
						b24_filter_attributes: before['b24_filter_attributes'],
						b24_filter_schema_version: before['b24_filter_schema_version'],
						b24_filter_updated_at: before['b24_filter_updated_at'],
						image: before['image'],
					});
					await updateCoreCatalogPrices(erp, {
						productId,
						retail: beforePrices?.retail ?? 0,
						purchase: beforePrices?.purchase ?? 0,
					});
				} catch (rollbackError) {
					app.log.error({ productId }, `[api/catalog/update-product] rollback failed — ${errInfo(rollbackError)}`);
				}
			}
			app.log.error({ productId, iblockId }, `[api/catalog/update-product] failed — ${errInfo(error)}`);
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
		const article = cleanText(body['article']) || model;
		const sectionId = Number(body['sectionId']);
		const sectionNameInput = cleanText(body['sectionName']);
		const summary = cleanMultiline(body['summary'] ?? body['description']).slice(0, 4_000);
		const category = cleanText(body['filterCategory']).slice(0, 120) || sectionNameInput;
		const status = cleanText(body['status']);
		const retail = Number(body['retail']);
		const purchase = Number(body['purchase'] ?? 0);
		const isService = body['isService'] === true;
		const similarReviewed = body['similarReviewed'] === true;
		let content: CatalogProductContent;
		let photo: ReturnType<typeof catalogPhoto>;
		try {
			content = createCatalogContent(summary, body['attributes'] ?? []);
			photo = catalogPhoto(body['photo']);
		} catch (error) {
			return reply.code(400).send({ ok: false, error: errInfo(error) });
		}
		if (productType.length < 3) return reply.code(400).send({ ok: false, error: isService ? 'укажи название услуги' : 'укажи вид товара' });
		if (!isService && manufacturer.length < 2) return reply.code(400).send({ ok: false, error: 'укажи производителя' });
		if (!isService && model.length < 2) return reply.code(400).send({ ok: false, error: 'укажи полную модель или артикул' });
		if (!Number.isInteger(sectionId) || sectionId <= 0) return reply.code(400).send({ ok: false, error: 'выбери раздел каталога' });
		if (!(retail > 0)) return reply.code(400).send({ ok: false, error: 'цена продажи должна быть больше нуля' });
		if (!isService && (!Number.isFinite(purchase) || purchase < 0)) return reply.code(400).send({ ok: false, error: 'закупочная цена должна быть 0 или больше' });
		const allowedStatuses = new Set([
			'После ремонта', 'Снят с производства', 'Недоступен к заказу', 'К удалению',
			'Уценка', 'Витринный', 'Б/у', 'Распродажа', 'Повреждённый',
			'Некондиция', 'Демо', 'Образец', 'Сток',
		]);
		const statuses = status.split(',').map(cleanText).filter(Boolean);
		if (statuses.some((value) => !allowedStatuses.has(value)) || new Set(statuses).size !== statuses.length) {
			return reply.code(400).send({ ok: false, error: 'выбран неизвестный или повторяющийся статус товара' });
		}

		const name = isService ? productType : productTitle(productType, manufacturer, model);
		const cacheKey = normalizeDomain(body.domain ?? '');
		try {
			return await serializeProductCreate(async () => {
				const cachedRows = (baseCache.get(cacheKey)?.data.rows ?? []) as CatalogCandidate[];
				const sectionName = cachedRows.find((row) => row.sectionId === sectionId)?.sectionName || sectionNameInput;
				const fresh = await freshExactCandidates(client, { name, model });
				const merged = new Map<number, CatalogCandidate>();
				for (const row of [...cachedRows, ...fresh]) merged.set(row.id, row);
				const candidates = rankedCandidates([...merged.values()], { name, model, manufacturer, isService });
				const exact = candidates.filter((candidate) => candidate.exact);
				if (exact.length) return { ok: true, status: 'duplicate', name, candidates: exact };
				if (candidates.length && !similarReviewed) return { ok: true, status: 'review', name, candidates };

				let productId = 0;
				let coreCreated = false;
				let uploadedFileName = '';
				let photoPath = '';
				try {
					const created = await client.call<{ element?: { id?: number | string } }>('catalog.product.add', {
						fields: {
							iblockId: 24,
							name,
							type: isService ? 7 : 1,
							measure: 9,
							active: 'Y',
							iblockSectionId: sectionId,
							...(!isService ? {
								property334: manufacturer,
								property330: model,
							} : {}),
						},
					});
					productId = Number(created?.element?.id ?? 0) || 0;
					if (!productId) throw new Error('catalog.product.add не вернул id');
					if (await erp.get('Item', String(productId))) throw new Error(`в ядре уже существует товар с новым ID ${productId}`);
					await ensureCoreItem(erp, {
						productId,
						name,
						...(isService ? { isService: true } : { model, article, brand: manufacturer }),
						section: sectionName,
						description: renderCatalogDescription(content),
					});
					coreCreated = true;
					await erp.update('Item', String(productId), {
						b24_product_status: statuses.join(', '),
						b24_catalog_content: JSON.stringify(content),
						b24_filter_category: category,
						b24_filter_attributes: serializeFilterAttributes(content, category),
						b24_filter_schema_version: '1',
						b24_filter_updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
					});
					if (photo) {
						const uploaded = await erp.uploadPublicFile({
							fileName: photo.fileName,
							mimeType: photo.mimeType,
							content: photo.content,
							doctype: 'Item',
							docname: String(productId),
							fieldname: 'image',
						});
						uploadedFileName = uploaded.name;
						photoPath = uploaded.fileUrl;
						await erp.update('Item', String(productId), { image: uploaded.fileUrl });
					}
					await updateCoreCatalogPrices(erp, { productId, retail, purchase: isService ? 0 : purchase });
				} catch (error) {
					if (uploadedFileName) await erp.delete('File', uploadedFileName).catch(() => undefined);
					if (coreCreated) await erp.delete('Item', String(productId)).catch(() => undefined);
					if (productId) await client.call('catalog.product.delete', { id: productId }).catch(() => undefined);
					throw error;
				}

				baseCache.delete(cacheKey);
				const row: CatalogCandidate = {
					id: productId,
					iblockId: 24,
					name,
					isService,
					article: isService ? '' : article,
					model: isService ? '' : model,
					manufacturer: isService ? '' : manufacturer,
					sectionId,
					sectionName,
					status: statuses.join(', '),
					description: renderCatalogDescription(content),
					content,
					filterCategory: category,
					retail,
					purchase: isService ? 0 : purchase,
					...(photoPath ? { photoPath: `/api/inventory/erp-image?p=${encodeURIComponent(photoPath)}` } : {}),
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
	// Гейт env ERPNEXT_URL: ядро не подключено → явная ошибка, без складского фолбэка Б24.
	// Склады отдаём по имени и маппим в стабильные ID интерфейса из справочника ядра.
	app.post('/api/catalog/erp-stocks', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { productIds?: unknown };
		if (!body.domain || normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) {
			return reply.code(403).send({ ok: false, error: 'bad domain' });
		}
		const requestedIds = (Array.isArray(body.productIds) ? body.productIds : [])
			.map(Number).filter((n) => Number.isInteger(n) && n > 0);
		if (!requestedIds.length) return { ok: true, byProduct: {} };
		const ids = [...new Set(requestedIds.map(canonicalProductId))];
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, coreOff: true, error: 'ядро не подключено (ERPNEXT_URL)' });
		try {
			// Запрашиваем только нужные item_code: полный Bin избыточен и заметно замедляет ответ.
			const [stocks, purchasing] = await Promise.all([
				fetchErpStocksFor(erp, ids),
				fetchErpPurchasing(erp, ids),
			]);
			// Возвращаем КАЖДЫЙ запрошенный товар (даже с нулём — чтобы не потерять закупку у бесстоковых).
			const byProduct: Record<number, { stocks: Record<string, number>; purchasing: number }> = {};
			const canViewPurchasePrices = appPermission(req, 'catalog.view_purchase_prices', true);
			for (const requestedId of requestedIds) {
				const pid = canonicalProductId(requestedId);
				byProduct[requestedId] = {
					stocks: stocks.get(pid) ?? {},
					purchasing: canViewPurchasePrices ? purchasing.get(pid) ?? 0 : 0,
				};
			}
			app.log.info({ products: Object.keys(byProduct).length }, '[api/catalog/erp-stocks] ok');
			return { ok: true, byProduct };
		} catch (err) {
			app.log.error({}, `[api/catalog/erp-stocks] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
