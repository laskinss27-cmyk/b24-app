import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { cancelRefusedRepairDeal, reframeRefusedRepairTask } from './repair-refusal-effects.js';
import type { RepairData } from './repair-record.js';
import { currentUser } from './repair-user-access.js';

interface AuthBody { domain?: string; accessToken?: string }
type RepairClientFrom = (body: AuthBody) => B24Client | null;
type RepairSystemClient = () => B24Client | null;

function errInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : String(error);
}

export function registerRepairClientRefusalRoute(
	app: FastifyInstance,
	clientFrom: RepairClientFrom,
	systemClient: RepairSystemClient,
): void {
	app.post('/api/repairs/refuse', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { id?: unknown; reason?: unknown };
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(body.id);
		const reason = String(body.reason ?? '').trim();
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		if (reason.length < 3 || reason.length > 500) {
			return reply.code(400).send({ ok: false, error: 'укажи причину отказа (от 3 до 500 символов)' });
		}
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', {
				ENTITY: REPAIRS_ENTITY,
				FILTER: { ID: id },
			});
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			if (data.kind === 'presale') return reply.code(400).send({ ok: false, error: 'отказ клиента применим только к клиентскому ремонту' });
			if (data.status === 'issued') return reply.code(400).send({ ok: false, error: 'оборудование уже выдано клиенту' });
			const me = await currentUser(client);
			if (!appPermission(req, 'repairs.change_status', me.canEditPrice)) {
				return reply.code(403).send({ ok: false, error: 'нет права оформить отказ клиента' });
			}
			if (data.clientRefusal && data.clientRefusal.reason !== reason) {
				return reply.code(409).send({ ok: false, error: 'отказ уже оформлен с другой причиной' });
			}
			if (!data.clientRefusal) {
				const now = new Date().toISOString();
				data.clientRefusal = {
					at: now,
					reason,
					byId: me.id,
					byName: me.name,
					dealCancelled: false,
					taskReframed: false,
				};
				data.history = Array.isArray(data.history) ? data.history : [];
				data.history.push({
					at: now,
					status: data.status,
					byId: me.id,
					byName: me.name,
					note: `клиент отказался от ремонта: ${reason}`,
				});
				await client.call('entity.item.update', {
					ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data),
				});
			}

			const warnings: string[] = [];
			const effectClient = systemClient() ?? client;
			if (!data.clientRefusal.dealCancelled) {
				try {
					await cancelRefusedRepairDeal(effectClient, data, app.log);
					data.clientRefusal.dealCancelled = true;
				} catch (error) {
					warnings.push(`сделка пока не отменена: ${errInfo(error)}`);
				}
			}
			if (!data.clientRefusal.taskReframed) {
				try {
					await reframeRefusedRepairTask(effectClient, data, id);
					data.clientRefusal.taskReframed = true;
				} catch (error) {
					warnings.push(`задача пока не обновлена: ${errInfo(error)}`);
				}
			}
			await client.call('entity.item.update', {
				ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data),
			});
			app.log.info({ id, warnings }, '[api/repairs/refuse] saved');
			return { ok: true, repair: { id, name: String(raw['NAME'] ?? ''), ...data }, warnings };
		} catch (error) {
			app.log.error({ id }, `[api/repairs/refuse] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});
}
