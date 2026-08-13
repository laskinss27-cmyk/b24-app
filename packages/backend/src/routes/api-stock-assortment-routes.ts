import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import {
	buildAssortmentMatrixReport,
	saveAssortmentMatrixItem,
	type MatrixSalesScope,
} from '../erp/assortment-matrix.js';
import { canUseAssortmentMatrix } from './api-stock-access.js';
import { matrixCategories } from './api-stock-matrix-categories.js';
import { moscowDate, stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody } from './api-stock-types.js';

export function registerStockAssortmentRoutes(app: FastifyInstance): void {
	app.post('/api/stock/assortment-matrix', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & {
			from?: unknown; to?: unknown; selectedStores?: unknown; salesScope?: unknown;
		};
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!(await canUseAssortmentMatrix(client))) return reply.code(403).send({ ok: false, error: 'нет доступа к матрице заказов' });
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
			const [report, categories] = await Promise.all([
				buildAssortmentMatrixReport(erp, { from, to, selectedStores, salesScope }),
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
		if (!(await canUseAssortmentMatrix(client))) return reply.code(403).send({ ok: false, error: 'нет доступа к матрице заказов' });
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
}
