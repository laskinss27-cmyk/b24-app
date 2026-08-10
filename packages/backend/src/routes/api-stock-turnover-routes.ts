import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { buildTurnoverReport } from '../erp/turnover-report.js';
import { buildTurnoverXlsx, type TurnoverExportFilters } from '../erp/turnover-report-xlsx.js';
import { moscowDate, stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody } from './api-stock-types.js';

export function registerStockTurnoverRoutes(app: FastifyInstance): void {
	app.post('/api/stock/turnover-report', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & { from?: unknown; to?: unknown; store?: unknown };
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
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
		const store = String(b.store ?? '').trim();
		try {
			const data = await buildTurnoverReport(erp, { from, to, ...(store ? { store } : {}) });
			app.log.info({ rows: data.rows.length, from, to, store }, '[api/stock/turnover-report] ok');
			return { ok: true, ...data };
		} catch (e) {
			app.log.error({}, `[api/stock/turnover-report] failed — ${stockErrorInfo(e)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(e) });
		}
	});

	app.post('/api/stock/turnover-report.xlsx', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & {
			from?: unknown; to?: unknown; store?: unknown; search?: unknown; status?: unknown; section?: unknown;
			showAverageCost?: unknown; showStockValue?: unknown;
		};
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
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
		const store = String(b.store ?? '').trim();
		const statusValue = String(b.status ?? '').trim();
		const allowedStatuses = new Set(['ending', 'ordered', 'normal', 'excess', 'no_movement', 'no_stock']);
		const filters: TurnoverExportFilters = {
			showAverageCost: b.showAverageCost !== false,
			showStockValue: b.showStockValue !== false,
			...(String(b.search ?? '').trim() ? { search: String(b.search).trim() } : {}),
			...(String(b.section ?? '').trim() ? { section: String(b.section).trim() } : {}),
			...(allowedStatuses.has(statusValue) ? { status: statusValue as NonNullable<TurnoverExportFilters['status']> } : {}),
		};
		try {
			const report = await buildTurnoverReport(erp, { from, to, ...(store ? { store } : {}) });
			const file = await buildTurnoverXlsx({
				from, to, store, rows: report.rows, filters, generatedAt: new Date(),
			});
			app.log.info({ rows: report.rows.length, from, to, store }, '[api/stock/turnover-report.xlsx] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
				.header('Content-Disposition', `attachment; filename="turnover-${from}-${to}.xlsx"`)
				.header('Cache-Control', 'no-store')
				.send(file);
		} catch (e) {
			app.log.error({}, `[api/stock/turnover-report.xlsx] failed — ${stockErrorInfo(e)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(e) });
		}
	});
}
