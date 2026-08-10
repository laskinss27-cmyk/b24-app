import type { FastifyInstance } from 'fastify';
import { ensureInventoryEntity, INVENTORY_ENTITY } from '../b24/placement.js';
import { inventoryClientFrom, inventoryErrorInfo } from './api-inventory-route-helpers.js';
import type { InventoryAuthBody } from './api-inventory-types.js';

export function registerInventoryCreateRoute(app: FastifyInstance): void {
	app.post('/api/inventory/create', async (req, reply) => {
		const b = (req.body ?? {}) as InventoryAuthBody & { title?: string; points?: unknown; createdById?: string; deadline?: string; notifyUserIds?: unknown; sectionIds?: unknown };
		const client = inventoryClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.title || !Array.isArray(b.points) || !b.points.length) {
			return reply.code(400).send({ ok: false, error: 'title/points required' });
		}

		await ensureInventoryEntity(client);
		try {
			const sectionIds = Array.isArray(b.sectionIds) ? b.sectionIds.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [];
			await client.call('entity.item.add', {
				ENTITY: INVENTORY_ENTITY,
				NAME: b.title,
				DETAIL_TEXT: JSON.stringify({ status: 'active', deadline: b.deadline ?? '', points: b.points, createdById: b.createdById ?? '', createdAt: new Date().toISOString(), sectionIds }),
			});

			if (b.createdById) {
				const responsible = String(b.createdById);
				let accomplices: number[] = [];
				if (app.config.inventoryNotify === 'on' && Array.isArray(b.notifyUserIds)) {
					accomplices = [...new Set(b.notifyUserIds.map((s) => String(s).trim()))]
						.filter((s) => s && s !== responsible)
						.map((s) => Number(s))
						.filter((n) => Number.isInteger(n) && n > 0);
				}
				try {
					await client.call('tasks.task.add', {
						fields: {
							TITLE: `Инвентаризация: ${b.title}`,
							DESCRIPTION: `Создана инвентаризация «${b.title}»${b.deadline ? `, срок до ${b.deadline}` : ''}. Откройте раздел «Инвентаризация» в приложении и возьмите свою точку.${app.config.appSectionUrl ? `\n${app.config.appSectionUrl}` : ''}`,
							RESPONSIBLE_ID: Number(b.createdById),
							...(accomplices.length ? { ACCOMPLICES: accomplices } : {}),
							...(b.deadline ? { DEADLINE: b.deadline } : {}),
						},
					});
					app.log.info({ notify: app.config.inventoryNotify, accomplices: accomplices.length }, '[api/inventory/create] notify task created');
				} catch (e) {
					app.log.warn({}, `[api/inventory/create] notify task failed — ${inventoryErrorInfo(e)}`);
				}
			}

			app.log.info({}, '[api/inventory/create] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({}, `[api/inventory/create] failed — ${inventoryErrorInfo(err)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
		}
	});
}
