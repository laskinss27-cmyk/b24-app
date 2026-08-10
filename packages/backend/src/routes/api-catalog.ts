import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import {
	ensureCoreItem, fetchErpStocksFor, fetchErpPurchasing,
	fetchCoreCatalogPrices,
	updateCoreCatalogPrices,
} from '../erp/operations.js';
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
} from './api-catalog-types.js';
import { catalogAccess, catalogClientFrom, errInfo } from './api-catalog-route-helpers.js';
import { baseCache, CACHE_TTL_MS } from './api-catalog-cache.js';
import {
	catalogPhoto,
	cleanMultiline,
	cleanText,
	productTitle,
} from './api-catalog-value-helpers.js';
import { buildCoreProductBase } from './api-catalog-core-base.js';
import { freshExactCandidates, rankedCandidates } from './api-catalog-candidates.js';
import { serializeProductCreate } from './api-catalog-product-creation-queue.js';
import { registerCatalogBrowseRoutes } from './api-catalog-browse-routes.js';
import { registerCatalogExportRoutes } from './api-catalog-export-routes.js';
import { registerCatalogCommercialFieldRoutes } from './api-catalog-commercial-field-routes.js';

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
export function registerApiCatalogRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => catalogClientFrom(app, body);
	registerCatalogBrowseRoutes(app);
	registerCatalogExportRoutes(app);
	registerCatalogCommercialFieldRoutes(app);

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
