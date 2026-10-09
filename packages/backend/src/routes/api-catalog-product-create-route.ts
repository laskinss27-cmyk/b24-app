import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { ensureCoreItem, updateCoreCatalogPrices } from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import { appPermission } from '../access-policy.js';
import {
	canDelegateCatalogProductCreation,
	canCopyCatalogProduct,
	catalogAccessForUser,
	type CatalogAccessUser,
} from '../catalog-access.js';
import { addCatalogProductWithAccessFallback } from '../catalog-product-writer.js';
import {
	createCatalogContent,
	renderCatalogDescription,
	serializeFilterAttributes,
	type CatalogProductContent,
} from '../catalog-content.js';
import type { AuthBody, CatalogCandidate } from './api-catalog-types.js';
import { catalogClientFrom, errInfo } from './api-catalog-route-helpers.js';
import { baseCache } from './api-catalog-cache.js';
import { catalogPhoto, cleanMultiline, cleanText, productTitle } from './api-catalog-value-helpers.js';
import { freshExactCandidates, rankedCandidates } from './api-catalog-candidates.js';
import { readCopySource, validateCopyBundle, registerCatalogCopyDetailsRoute } from './api-catalog-product-copy.js';
import { serializeProductCreate } from './api-catalog-product-creation-queue.js';

export function registerCatalogProductCreateRoute(app: FastifyInstance): void {
	registerCatalogCopyDetailsRoute(app);
	app.post('/api/catalog/create-product', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const currentUser = await client.call<CatalogAccessUser>('user.current', {}).catch(() => null);
		const legacyAccess = catalogAccessForUser(currentUser);
		const copying = body['copySourceId'] !== undefined;
		if (copying ? !canCopyCatalogProduct(currentUser) : !appPermission(req, 'catalog.create', legacyAccess.canEditCard)) {
			return reply.code(403).send({ ok: false, error: 'нет права создавать карточки товаров' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });

		let copySource: Awaited<ReturnType<typeof readCopySource>> | null = null;
		let bundleFields: Record<string, unknown> = {};
		if (copying) {
			try {
				copySource = await readCopySource(erp, body['copySourceId']);
				bundleFields = await validateCopyBundle(erp, copySource.bundle, body['bundle']);
			} catch (error) { return reply.code(400).send({ ok: false, error: errInfo(error) }); }
		}
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
		const isService = copySource ? copySource.isService : body['isService'] === true;
		const similarReviewed = body['similarReviewed'] === true;
		let content: CatalogProductContent;
		let photo: ReturnType<typeof catalogPhoto>;
		try {
			content = createCatalogContent(summary, body['attributes'] ?? []);
			photo = copying ? null : catalogPhoto(body['photo']);
		} catch (error) {
			return reply.code(400).send({ ok: false, error: errInfo(error) });
		}
		if (productType.length < 3) return reply.code(400).send({ ok: false, error: isService ? 'укажи название услуги' : 'укажи вид товара' });
		if (!copying && !isService && manufacturer.length < 2) return reply.code(400).send({ ok: false, error: 'укажи производителя' });
		if (!copying && !isService && model.length < 2) return reply.code(400).send({ ok: false, error: 'укажи полную модель или артикул' });
		if (!Number.isInteger(sectionId) || sectionId <= 0) return reply.code(400).send({ ok: false, error: 'выбери раздел каталога' });
		if (!Number.isFinite(retail) || !(retail > 0)) return reply.code(400).send({ ok: false, error: 'цена продажи должна быть больше нуля' });
		if (!isService && (!Number.isFinite(purchase) || purchase < 0)) return reply.code(400).send({ ok: false, error: 'закупочная цена должна быть 0 или больше' });
		if (copying && !isService && (body['purchase'] == null || String(body['purchase']).trim() === '')) return reply.code(400).send({ ok: false, error: 'Укажи закупочную цену новой карточки' });
		if (copying && productType.length > 140) return reply.code(400).send({ ok: false, error: 'Название новой карточки — не больше 140 символов' });
		const allowedStatuses = new Set([
			'После ремонта', 'Снят с производства', 'Недоступен к заказу', 'К удалению',
			'Уценка', 'Витринный', 'Б/у', 'Распродажа', 'Повреждённый',
			'Некондиция', 'Демо', 'Образец', 'Сток',
		]);
		const statuses = status.split(',').map(cleanText).filter(Boolean);
		if (statuses.some((value) => !allowedStatuses.has(value)) || new Set(statuses).size !== statuses.length) {
			return reply.code(400).send({ ok: false, error: 'выбран неизвестный или повторяющийся статус товара' });
		}

		const name = copying || isService ? productType : productTitle(productType, manufacturer, model);
		const cacheKey = normalizeDomain(body.domain ?? '');
		try {
			return await serializeProductCreate(async () => {
				const cachedRows = (baseCache.get(cacheKey)?.data.rows ?? []) as CatalogCandidate[];
				const sectionName = cachedRows.find((row) => row.sectionId === sectionId)?.sectionName || sectionNameInput;
				const fresh = await freshExactCandidates(client, { name, model });
				// A copy must also check ERP: Bitrix metadata/cache may be unavailable or stale.
				if (copying) {
					const core = await erp.list('Item', ['name', 'item_name', 'is_stock_item', 'b24_model', 'b24_article', 'b24_brand'], [], 0);
					for (const item of core) fresh.push({ id: Number(item.name), iblockId: 24, name: String(item.item_name), isService: Number(item.is_stock_item) === 0,
						model: String(item.b24_model ?? ''), article: String(item.b24_article ?? ''), manufacturer: String(item.b24_brand ?? ''), retail: null, purchase: null, total: 0, stockByStore: {} });
				}
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
				let productWriter = client;
				let delegated = false;
				try {
					const written = await addCatalogProductWithAccessFallback<{ element?: { id?: number | string } }>({
						userClient: client,
						systemClient: (canDelegateCatalogProductCreation(currentUser) || (copying && canCopyCatalogProduct(currentUser))) && app.config.catalogWriteWebhook
							? new B24Client({ auth: { kind: 'webhook', url: app.config.catalogWriteWebhook } })
							: null,
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
					const created = written.result;
					productWriter = written.client;
					delegated = written.delegated;
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
						...bundleFields,
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
					if (productId) await productWriter.call('catalog.product.delete', { id: productId }).catch(() => undefined);
					throw error;
				}

				baseCache.delete(cacheKey);
				const row: CatalogCandidate = {
					id: productId,
					iblockId: 24,
					name,
					isService,
					isMarketplaceBundle: Boolean(copySource?.bundle),
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
				app.log.info({ productId, name, sectionId, delegated, copySourceId: copying ? Number(body['copySourceId']) : undefined, actorId: currentUser?.ID }, '[api/catalog/create-product] ok');
				return { ok: true, status: 'created', name, product: row };
			});
		} catch (error) {
			app.log.error({}, `[api/catalog/create-product] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});
}
