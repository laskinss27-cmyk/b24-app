import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureInventoryEntity, INVENTORY_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';

/**
 * API инвентаризации для фронта. Фронтовый BX24 ВИСНЕТ на entity.* — поэтому
 * все операции с хранилищем (entity) делаем здесь, серверным B24Client (чистый
 * JSON, app-контекст). Фронт шлёт сюда свой BX24-токен (BX24.getAuth) + домен.
 *
 * Эндпоинты read/write только в нашей сущности ctv_inv; токен — самого юзера,
 * поэтому права Битрикса соблюдаются. Домен сверяем с порталом (allowlist).
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerApiInventoryRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	// Список инвентаризаций (+ идемпотентно создаёт хранилище, если его ещё нет).
	app.post('/api/inventory/list', async (req, reply) => {
		const client = clientFrom((req.body ?? {}) as AuthBody);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const ent = await ensureInventoryEntity(client);
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: INVENTORY_ENTITY });
			const inventories = (items ?? []).map((it) => {
				let parsed: Record<string, unknown> = {};
				try {
					parsed = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as Record<string, unknown>) : {};
				} catch {
					/* битый JSON — пропускаем */
				}
				return {
					id: String(it['ID'] ?? ''),
					title: String(it['NAME'] ?? ''),
					status: String(parsed['status'] ?? 'active'),
					points: Array.isArray(parsed['points']) ? parsed['points'] : [],
					createdById: String(parsed['createdById'] ?? it['CREATED_BY'] ?? ''),
					createdAt: String(parsed['createdAt'] ?? it['DATE_CREATE'] ?? ''),
				};
			});
			inventories.sort((a, b) => Number(b.id) - Number(a.id));
			app.log.info({ entity: ent.status, count: inventories.length }, '[api/inventory/list] ok');
			return { ok: true, entity: ent.status, inventories };
		} catch (err) {
			app.log.error({ entity: ent.status }, `[api/inventory/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), entity: ent.status });
		}
	});

	// Создать инвентаризацию.
	app.post('/api/inventory/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { title?: string; points?: unknown; createdById?: string };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.title || !Array.isArray(b.points) || !b.points.length) {
			return reply.code(400).send({ ok: false, error: 'title/points required' });
		}

		await ensureInventoryEntity(client);
		try {
			await client.call('entity.item.add', {
				ENTITY: INVENTORY_ENTITY,
				NAME: b.title,
				DETAIL_TEXT: JSON.stringify({ status: 'active', points: b.points, createdById: b.createdById ?? '', createdAt: new Date().toISOString() }),
			});
			app.log.info({}, '[api/inventory/create] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({}, `[api/inventory/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
