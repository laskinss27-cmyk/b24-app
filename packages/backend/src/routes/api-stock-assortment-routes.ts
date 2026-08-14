import type { FastifyInstance } from 'fastify';
import {
	AssortmentMatrixTemplateConflictError,
	AssortmentMatrixTemplateStore,
	type AssortmentMatrixTemplateRow,
} from '../assortment-matrix-template-store.js';
import { ErpClient } from '../erp/client.js';
import {
	buildAssortmentMatrixReport,
	saveAssortmentMatrixItem,
	type AssortmentMatrixItemInput,
	type MatrixSalesScope,
} from '../erp/assortment-matrix.js';
import { assortmentMatrixAccess } from './api-stock-access.js';
import { matrixCategories } from './api-stock-matrix-categories.js';
import { moscowDate, stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody } from './api-stock-types.js';

function matrixItems(value: unknown): AssortmentMatrixItemInput[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 1000) throw new Error('некорректный список товаров шаблона');
	const rows = value.map((raw) => {
		const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
		const productId = Number(item['productId']);
		const toOrderQty = Number(item['toOrderQty'] ?? 0);
		if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(toOrderQty) || toOrderQty < 0) throw new Error('некорректная строка товара шаблона');
		return {
			productId,
			category: String(item['category'] ?? '').trim().slice(0, 140),
			segment: String(item['segment'] ?? '').trim().slice(0, 140),
			toOrderQty,
			comment: String(item['comment'] ?? '').trim().slice(0, 1000),
		};
	});
	if (new Set(rows.map((row) => row.productId)).size !== rows.length) throw new Error('товар повторяется в шаблоне');
	return rows;
}

export function registerStockAssortmentRoutes(app: FastifyInstance): void {
	const templates = new AssortmentMatrixTemplateStore();
	app.post('/api/stock/assortment-matrix', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & {
			from?: unknown; to?: unknown; selectedStores?: unknown; salesScope?: unknown; items?: unknown;
		};
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!(await assortmentMatrixAccess(client)).allowed) return reply.code(403).send({ ok: false, error: 'нет доступа к матрице заказов' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const from = String(b.from ?? '');
		const to = String(b.to ?? '');
		const today = moscowDate();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
			return reply.code(400).send({ ok: false, error: 'нужны даты от и до' });
		}
		if (from > to) return reply.code(400).send({ ok: false, error: 'дата «от» должна быть раньше даты «до»' });
		if (to > today) return reply.code(400).send({ ok: false, error: 'отчёт нельзя построить за будущий период' });
		const selectedStores = Array.isArray(b.selectedStores)
			? b.selectedStores.map((value) => String(value).trim()).filter(Boolean).slice(0, 50)
			: [];
		const salesScope: MatrixSalesScope = b.salesScope === 'all' ? 'all' : 'selected';
		try {
			const items = matrixItems(b.items);
			const [report, categories] = await Promise.all([
				buildAssortmentMatrixReport(erp, { from, to, selectedStores, salesScope, ...(items !== undefined ? { items } : {}) }),
				matrixCategories(client).catch((error) => {
					app.log.warn({ error: stockErrorInfo(error) }, '[api/stock/assortment-matrix] categories unavailable');
					return [];
				}),
			]);
			app.log.info({ rows: report.rows.length, from, to, salesScope, stores: report.selectedStores.length }, '[api/stock/assortment-matrix] ok');
			return { ok: true, ...report, categories };
		} catch (error) {
			app.log.error({}, `[api/stock/assortment-matrix] failed — ${stockErrorInfo(error)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(error) });
		}
	});

	app.post('/api/stock/assortment-matrix/save', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & {
			productId?: unknown; enabled?: unknown; category?: unknown; segment?: unknown;
			toOrderQty?: unknown; comment?: unknown;
		};
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!(await assortmentMatrixAccess(client)).allowed) return reply.code(403).send({ ok: false, error: 'нет доступа к матрице заказов' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const productId = Number(b.productId);
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'некорректный товар' });
		try {
			await saveAssortmentMatrixItem(erp, {
				productId,
				enabled: b.enabled !== false,
				category: String(b.category ?? ''),
				segment: String(b.segment ?? ''),
				toOrderQty: Number(b.toOrderQty ?? 0),
				comment: String(b.comment ?? ''),
			});
			app.log.info({ productId, enabled: b.enabled !== false }, '[api/stock/assortment-matrix/save] ok');
			return { ok: true };
		} catch (error) {
			app.log.error({ productId }, `[api/stock/assortment-matrix/save] failed — ${stockErrorInfo(error)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(error) });
		}
	});

	app.post('/api/stock/assortment-matrix/templates', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody;
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!(await assortmentMatrixAccess(client)).allowed) return reply.code(403).send({ ok: false, error: 'нет доступа к матрице заказов' });
		try {
			return { ok: true, templates: await templates.list() };
		} catch (error) {
			app.log.error({ error: stockErrorInfo(error) }, '[api/stock/assortment-matrix/templates] failed');
			return reply.code(500).send({ ok: false, error: stockErrorInfo(error) });
		}
	});

	app.post('/api/stock/assortment-matrix/templates/save', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & Record<string, unknown>;
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const access = await assortmentMatrixAccess(client);
		if (!access.allowed) return reply.code(403).send({ ok: false, error: 'нет доступа к матрице заказов' });
		try {
			const rows = matrixItems(b['rows']) ?? [];
			const template = await templates.save(access.actor, {
				...(typeof b['id'] === 'string' && b['id'] ? { id: b['id'] } : {}),
				name: String(b['name'] ?? ''), from: String(b['from'] ?? ''), to: String(b['to'] ?? ''),
				selectedStores: Array.isArray(b['selectedStores']) ? b['selectedStores'].map(String) : [],
				salesScope: b['salesScope'] === 'all' ? 'all' : 'selected', rows: rows as AssortmentMatrixTemplateRow[],
				...(typeof b['expectedUpdatedAt'] === 'string' ? { expectedUpdatedAt: b['expectedUpdatedAt'] } : {}),
			});
			await app.operationLog.record({
				area: 'supply', operation: b['id'] ? 'update_assortment_matrix_template' : 'create_assortment_matrix_template', outcome: 'success',
				summary: `${b['id'] ? 'Обновлён' : 'Создан'} шаблон матрицы заказов «${template.name}» (${template.rows.length} позиций).`,
				actor: access.actor, details: { templateId: template.id, rows: template.rows.length },
			});
			return { ok: true, template };
		} catch (error) {
			return reply.code(error instanceof AssortmentMatrixTemplateConflictError ? 409 : 400).send({ ok: false, error: stockErrorInfo(error) });
		}
	});

	app.post('/api/stock/assortment-matrix/templates/delete', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & { id?: unknown; name?: unknown };
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const access = await assortmentMatrixAccess(client);
		if (!access.allowed) return reply.code(403).send({ ok: false, error: 'нет доступа к матрице заказов' });
		const id = String(b.id ?? '');
		try {
			if (!(await templates.delete(id))) return reply.code(404).send({ ok: false, error: 'шаблон матрицы не найден' });
			await app.operationLog.record({
				area: 'supply', operation: 'delete_assortment_matrix_template', outcome: 'success', level: 'warning',
				summary: `Удалён шаблон матрицы заказов «${String(b.name ?? id).slice(0, 80)}».`, actor: access.actor, details: { templateId: id },
			});
			return { ok: true };
		} catch (error) {
			return reply.code(500).send({ ok: false, error: stockErrorInfo(error) });
		}
	});
}
