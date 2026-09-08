import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { ErpClient } from '../erp/client.js';
import { fetchErpSnapshotStockFull } from '../erp/operations.js';
import { prepareInventoryExport } from '../inventory-export.js';
import { createInventoryWorkbook } from '../inventory-xlsx.js';
import { inventoryClientFrom, inventoryErrorInfo } from './api-inventory-route-helpers.js';
import type { InventoryAuthBody } from './api-inventory-types.js';
import { loadInventoryItems } from './inventory-storage.js';

export function registerInventoryExportRoute(app: FastifyInstance): void {
	app.post('/api/inventory/export-xlsx', async (req, reply) => {
		const body = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: unknown; storeId?: unknown };
		const client = inventoryClientFrom(app, body);
		if (!client || !appPermission(req, 'inventory.view', true)) return reply.code(403).send({ ok: false, error: 'Нет доступа к инвентаризации' });
		if (typeof body.inventoryId !== 'string' || !/^\d{1,16}$/.test(body.inventoryId)
			|| (body.storeId !== undefined && (typeof body.storeId !== 'number' || !Number.isSafeInteger(body.storeId)))) {
			return reply.code(400).send({ ok: false, error: 'Неверная инвентаризация или склад' });
		}
		try {
			// SQL reads must still verify the caller's token, even if the global hook fails open.
			const me = await client.call<{ ID?: string | number }>('user.current', {});
			if (!me?.ID) return reply.code(403).send({ ok: false, error: 'Не удалось подтвердить пользователя' });
			const items = await loadInventoryItems(app, client, 'export');
			const item = items.find((candidate) => String(candidate['ID']) === body.inventoryId);
			if (!item) return reply.code(404).send({ ok: false, error: 'Инвентаризация не найдена' });
			const data = prepareInventoryExport(item, body.storeId as number | undefined);
			const ids = new Map(data.points.flatMap((point) => point.lines.map((line) => [line.productId, 0] as [number, number])));
			if (ids.size) {
				const erp = ErpClient.fromEnv();
				if (!erp) throw new Error('Ядро каталога недоступно. Повторите выгрузку позже.');
				// Only Item metadata is read here, not Bin quantities or accounting documents.
				const cards = new Map((await fetchErpSnapshotStockFull(erp, ids)).map((card) => [card.productId, card]));
				for (const point of data.points) {
					for (const line of point.lines) {
						const card = cards.get(line.productId);
						line.name ||= card?.name ?? `Товар #${line.productId}`;
						line.article = card?.article ?? '';
					}
					point.lines.sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.productId - b.productId);
				}
			}
			const buffer = await createInventoryWorkbook(data).xlsx.writeBuffer();
			const filename = `Инвентаризация-${data.id}${body.storeId !== undefined ? `-склад-${body.storeId}` : ''}.xlsx`;
			reply.header('Cache-Control', 'no-store');
			reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
			reply.header('Content-Disposition', `attachment; filename="inventory-${data.id}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
			return reply.send(Buffer.from(buffer));
		} catch (error) {
			return reply.code(400).send({ ok: false, error: inventoryErrorInfo(error) });
		}
	});
}
