import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { fetchCoreCatalogPrices, updateCoreCatalogPrices } from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import {
	applyCatalogContentEdits,
	createCatalogContent,
	parseCatalogContent,
	renderCatalogDescription,
	serializeFilterAttributes,
} from '../catalog-content.js';
import { splitCatalogProductNameStatus } from '../catalog-product-status.js';
import { appPermission } from '../access-policy.js';
import type { AuthBody } from './api-catalog-types.js';
import { catalogAccess, catalogClientFrom, errInfo } from './api-catalog-route-helpers.js';
import { baseCache } from './api-catalog-cache.js';
import { catalogPhoto, cleanMultiline, cleanText } from './api-catalog-value-helpers.js';

export function registerCatalogProductUpdateRoute(app: FastifyInstance): void {
	app.post('/api/catalog/update-product', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = catalogClientFrom(app, body);
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
}
