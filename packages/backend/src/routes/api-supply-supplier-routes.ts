import type { FastifyInstance } from 'fastify';
import type { AuthBody } from './api-supply-types.js';
import { ensureB24SupplierCompany, fetchSupplierCompanies, supplierNorm } from './api-supply-suppliers.js';
import { errInfo, supplyClientFrom } from './api-supply-route-helpers.js';

export function registerSupplySupplierRoutes(app: FastifyInstance): void {
	app.post('/api/supply/suppliers', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		try {
			return { ok: true, suppliers: await fetchSupplierCompanies(client) };
		} catch (err) {
			app.log.error({}, `[api/supply/suppliers] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), suppliers: [] });
		}
	});

	app.post('/api/supply/supplier/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { name?: unknown };
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const name = String(b.name ?? '').trim();
		if (name.length < 2 || name === 'Поставщик не выбран') return reply.code(400).send({ ok: false, error: 'укажи название поставщика' });
		try {
			const before = await fetchSupplierCompanies(client);
			const existing = before.find((supplier) => supplierNorm(supplier) === supplierNorm(name));
			if (existing) return { ok: true, name: existing, suppliers: before, created: false };
			await ensureB24SupplierCompany(client, name);
			const suppliers = [...before, name].sort((a, b) => a.localeCompare(b, 'ru'));
			return { ok: true, name, suppliers, created: true };
		} catch (err) {
			app.log.error({ name }, `[api/supply/supplier/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
