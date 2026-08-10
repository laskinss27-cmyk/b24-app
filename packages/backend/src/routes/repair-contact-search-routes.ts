import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type RepairClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerRepairContactSearchRoutes(app: FastifyInstance, clientFrom: RepairClientFrom): void {
	// Поиск контакта по ТЕЛЕФОНУ (контроль дублей при приёмке). Б24 не даст завести контакт с занятым
	// номером — поэтому до сохранения показываем приёмщику, кто уже сидит на этом номере. null — свободен.
	app.post('/api/repairs/find-by-phone', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { phone?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const phone = String(b.phone ?? '').trim();
		if (phone.length < 4) return { ok: true, contact: null };
		try {
			const dup = await client.call<{ CONTACT?: Array<number | string> }>('crm.duplicate.findbycomm', { type: 'PHONE', values: [phone], entity_type: 'CONTACT' });
			const id = Number((dup?.CONTACT ?? [])[0] ?? 0);
			if (!id) return { ok: true, contact: null };
			const c = await client.call<{ NAME?: string; LAST_NAME?: string; SECOND_NAME?: string; PHONE?: Array<{ VALUE?: string }> }>('crm.contact.get', { id });
			const name = [c?.LAST_NAME, c?.NAME, c?.SECOND_NAME].filter(Boolean).join(' ').trim();
			return { ok: true, contact: { id, name: name || `Контакт #${id}`, phone: String(c?.PHONE?.[0]?.VALUE ?? phone) } };
		} catch (err) {
			app.log.warn({}, `[api/repairs/find-by-phone] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Поиск контакта Б24 по ФИО (для поля «Клиент»). Ищем по имени и фамилии, мержим, топ-10.
	app.post('/api/repairs/search-contacts', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { q?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const q = String(b.q ?? '').trim();
		if (q.length < 2) return { ok: true, contacts: [] as Array<{ id: number; name: string; phone: string }> };
		try {
			const select = ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'PHONE'];
			const byName = new Map<number, { id: number; name: string; phone: string }>();
			for (const f of [{ '%LAST_NAME': q }, { '%NAME': q }]) {
				const res = await client.call<Array<Record<string, unknown>>>('crm.contact.list', { filter: f, select, order: { LAST_NAME: 'ASC' } }).catch(() => []);
				for (const c of res ?? []) {
					const id = Number(c['ID']);
					if (!id || byName.has(id)) continue;
					const name = [c['LAST_NAME'], c['NAME'], c['SECOND_NAME']].filter(Boolean).join(' ').trim();
					const phones = c['PHONE'] as Array<{ VALUE?: string }> | undefined;
					byName.set(id, { id, name: name || `Контакт #${id}`, phone: String(phones?.[0]?.VALUE ?? '') });
					if (byName.size >= 10) break;
				}
				if (byName.size >= 10) break;
			}
			return { ok: true, contacts: [...byName.values()] };
		} catch (err) {
			app.log.error({}, `[api/repairs/search-contacts] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
