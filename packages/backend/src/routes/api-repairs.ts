import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureRepairsEntity, REPAIRS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';

/**
 * API модуля «Ремонты» (RMA). Всё наше: карточки лежат в нашем entity-store ctv_repairs,
 * НЕ в нативной сущности Б24. От Б24 берём только клиента (поиск контакта) и Диск (фото).
 * Фронтовый BX24 виснет на entity.* → все операции с хранилищем тут, серверным B24Client.
 *
 *  - /api/repairs/list            — список ремонтов (+ идемпотентно создаёт хранилище)
 *  - /api/repairs/create          — принять в ремонт (новая карточка, статус «Принято»)
 *  - /api/repairs/update-status   — сменить статус (Принято→Отправлено→Вернулось→Выдано)
 *  - /api/repairs/search-contacts — поиск контакта Б24 по ФИО (для поля «Клиент»)
 *  - /api/repairs/upload-photo    — загрузка фото на Б24 Диск (возвращает ссылку)
 *
 * Токен — самого юзера (права Б24 соблюдаются). Домен — allowlist портала.
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

// Цепочка приёма теперь различает «на ТТ» и «в офисе» (где физически устройство):
// принято на ТТ → принято в офисе → отправлено в ремонт → отправлено на ТТ → готово к выдаче → выдано.
export type RepairStatus = 'received_tt' | 'received_office' | 'sent' | 'sent_to_tt' | 'ready_tt' | 'issued';
const STATUS_ORDER: RepairStatus[] = ['received_tt', 'received_office', 'sent', 'sent_to_tt', 'ready_tt', 'issued'];

/** Маппинг старых статусов (до разделения приёма ТТ/офис) на новые — чтобы прежние карточки не сломались. */
const LEGACY_STATUS: Record<string, RepairStatus> = {
	received: 'received_tt',
	sent: 'sent',
	returned: 'ready_tt',
	issued: 'issued',
};

function normalizeStatus(s: unknown): RepairStatus {
	const v = String(s ?? '');
	if (STATUS_ORDER.includes(v as RepairStatus)) return v as RepairStatus;
	return LEGACY_STATUS[v] ?? 'received_tt';
}

/** Кто может РЕДАКТИРОВАТЬ цену ремонта: Вова(1), Сергей(1858), Бекасов(986) + отдел Снабжение(10).
 * Остальные цену видят, но не меняют. Б24 не отдаёт флаг «админ» на бэке — главные админы в списке поимённо. */
const PRICE_EDITOR_IDS = new Set(['1', '1858', '986']);
const PRICE_EDITOR_DEPTS = new Set([10]);

/** Кэш id→ФИО на процесс (имена меняются редко) — чтобы не дёргать user.get на каждой загрузке. */
const userNameCache = new Map<string, string>();

/** Дорезолвить имена сотрудников по id (для старых записей истории, где сохранён только byId). */
async function resolveNames(client: B24Client, ids: Set<string>): Promise<void> {
	for (const uid of ids) {
		if (!uid || userNameCache.has(uid)) continue;
		try {
			const u = await client.call<Array<{ NAME?: string; LAST_NAME?: string }>>('user.get', { ID: uid });
			const usr = Array.isArray(u) ? u[0] : undefined;
			const nm = `${usr?.NAME ?? ''} ${usr?.LAST_NAME ?? ''}`.trim();
			if (nm) userNameCache.set(uid, nm);
		} catch { /* не вышло — оставим #id */ }
	}
}

interface CurrentUser { id: string; name: string; canEditPrice: boolean }

/** Текущий пользователь (по его токену) + право на правку цены. user.current отдаёт UF_DEPARTMENT. */
async function currentUser(client: B24Client): Promise<CurrentUser> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: unknown }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	const name = `${me?.NAME ?? ''} ${me?.LAST_NAME ?? ''}`.trim();
	const depts = Array.isArray(me?.UF_DEPARTMENT) ? (me?.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const canEditPrice = PRICE_EDITOR_IDS.has(id) || depts.some((d) => PRICE_EDITOR_DEPTS.has(d));
	return { id, name, canEditPrice };
}

interface RepairPhoto { id: number; name: string; url: string }
/** Прикреплённый документ (Word/Excel/PDF) — хранится на Диске Б24, в карточке только ссылка. */
interface RepairFile { id: number; name: string; url: string; type: string }

interface RepairData {
	status: RepairStatus;
	/** Свой номер ремонта (со 100), независимый от технического ID хранилища (общий счётчик портала). */
	repairNo: number;
	client: { contactId: number | null; name: string; phone: string };
	device: string;
	model: string;
	serial: string;
	/** Торговая точка приёма (название склада Б24). */
	point: string;
	appearance: string;
	defect: string;
	payType: 'warranty' | 'paid';
	/** Стоимость ремонта (только для платных; у гарантийных null). */
	cost: number | null;
	/** Комментарий сервисного центра (диагностика/итог ремонта) — заполняется после возврата. */
	comment: string;
	photos: RepairPhoto[];
	files: RepairFile[];
	createdAt: string;
	createdById: string;
	createdByName: string;
	/** Лог: смена статуса (note пуст) или изменение вида/цены (note описывает). byName — кто (для UI). */
	history: Array<{ at: string; status: RepairStatus; byId: string; byName?: string; note?: string }>;
}

/** entity.item → {id, ...data}. id записи = номер ремонта (для бланка). */
function parseItem(it: Record<string, unknown>): (RepairData & { id: number; name: string }) | null {
	let data: Partial<RepairData> = {};
	try { data = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as Partial<RepairData>) : {}; } catch { return null; }
	const id = Number(it['ID']);
	if (!Number.isInteger(id) || id <= 0) return null;
	const payType = data.payType ?? 'warranty';
	return {
		id,
		name: String(it['NAME'] ?? ''),
		status: normalizeStatus(data.status),
		repairNo: Number(data.repairNo) || 0,
		client: data.client ?? { contactId: null, name: '', phone: '' },
		device: data.device ?? '',
		model: data.model ?? '',
		serial: data.serial ?? '',
		point: data.point ?? '',
		appearance: data.appearance ?? '',
		defect: data.defect ?? '',
		payType,
		cost: payType === 'paid' && typeof data.cost === 'number' ? data.cost : null,
		comment: data.comment ?? '',
		photos: Array.isArray(data.photos) ? data.photos : [],
		files: Array.isArray(data.files) ? data.files : [],
		createdAt: data.createdAt ?? '',
		createdById: data.createdById ?? '',
		createdByName: data.createdByName ?? '',
		history: Array.isArray(data.history) ? data.history : [],
	};
}

export function registerApiRepairsRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	// Список ремонтов (+ идемпотентно создаёт хранилище, если его ещё нет).
	app.post('/api/repairs/list', async (req, reply) => {
		const client = clientFrom((req.body ?? {}) as AuthBody);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		await ensureRepairsEntity(client);
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, SORT: { ID: 'DESC' } });
			const repairs = (items ?? []).map(parseItem).filter((r): r is RepairData & { id: number; name: string } => r != null);
			// Дорезолвить имена в истории для старых записей (где сохранён только byId).
			const needIds = new Set<string>();
			for (const r of repairs) for (const h of r.history) if (!h.byName && h.byId) needIds.add(h.byId);
			if (needIds.size) {
				await resolveNames(client, needIds);
				for (const r of repairs) for (const h of r.history) {
					if (h.byName || !h.byId) continue;
					const nm = userNameCache.get(h.byId);
					if (nm) h.byName = nm;
				}
			}
			const me = await currentUser(client);
			return { ok: true, repairs, canEditPrice: me.canEditPrice };
		} catch (err) {
			app.log.error({}, `[api/repairs/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Принять в ремонт — новая карточка (статус «Принято»).
	app.post('/api/repairs/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const s = (v: unknown): string => String(v ?? '').trim();
		const device = s(b['device']);
		const clientName = s((b['client'] as { name?: unknown } | undefined)?.name);
		if (!device && !clientName) return reply.code(400).send({ ok: false, error: 'нужно хотя бы оборудование или клиент' });

		const photos: RepairPhoto[] = Array.isArray(b['photos'])
			? (b['photos'] as Array<Record<string, unknown>>).map((p) => ({ id: Number(p['id']) || 0, name: s(p['name']), url: s(p['url']) })).filter((p) => p.url)
			: [];
		const files: RepairFile[] = Array.isArray(b['files'])
			? (b['files'] as Array<Record<string, unknown>>).map((f) => ({ id: Number(f['id']) || 0, name: s(f['name']), url: s(f['url']), type: s(f['type']) })).filter((f) => f.url)
			: [];
		const payType: 'warranty' | 'paid' = b['payType'] === 'paid' ? 'paid' : 'warranty';
		const reqCost = payType === 'paid' && b['cost'] != null && b['cost'] !== '' && Number.isFinite(Number(b['cost'])) ? Number(b['cost']) : null;
		try {
			const me = await currentUser(client);
			const byId = me.id;
			const byName = me.name;
			const cost = me.canEditPrice ? reqCost : null; // цену проставит только тот, кому разрешено
			const now = new Date().toISOString();
			const cl = (b['client'] ?? {}) as { contactId?: unknown; name?: unknown; phone?: unknown };

			// Свой номер ремонта: со 100, дальше max+1. Независим от технического ID хранилища
			// (он общий счётчик портала → большие числа). Гонка при одновременном создании
			// маловероятна для канарейки; если список не прочитался — стартуем со 100, не падаем.
			let repairNo = 100;
			try {
				const existing = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, SORT: { ID: 'DESC' } });
				let max = 99;
				for (const it of existing ?? []) {
					try { const d = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as { repairNo?: unknown }) : {}; const n = Number(d.repairNo); if (Number.isFinite(n) && n > max) max = n; } catch { /* пропускаем битую запись */ }
				}
				repairNo = max + 1;
			} catch { /* не прочитали — оставим 100 */ }

			const data: RepairData = {
				status: 'received_tt',
				repairNo,
				client: { contactId: Number(cl.contactId) || null, name: s(cl.name), phone: s(cl.phone) },
				device,
				model: s(b['model']),
				serial: s(b['serial']),
				point: s(b['point']),
				appearance: s(b['appearance']),
				defect: s(b['defect']),
				payType,
				cost,
				comment: s(b['comment']),
				photos,
				files,
				createdAt: now,
				createdById: byId,
				createdByName: byName,
				history: [{ at: now, status: 'received_tt', byId, byName }],
			};
			const nameParts = [device, data.model, data.client.name].filter(Boolean);
			const added = await client.call<number | { id?: number }>('entity.item.add', {
				ENTITY: REPAIRS_ENTITY,
				NAME: nameParts.join(' · ') || 'Ремонт',
				DETAIL_TEXT: JSON.stringify(data),
			});
			const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!id) throw new Error('entity.item.add не вернул id');
			app.log.info({ id }, '[api/repairs/create] ok');
			return { ok: true, id, repair: { id, name: nameParts.join(' · '), ...data }, canEditPrice: me.canEditPrice };
		} catch (err) {
			app.log.error({}, `[api/repairs/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Редактировать ремонт (все поля карточки). Статус/историю/дату приёма/автора НЕ трогаем.
	app.post('/api/repairs/update', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b['id']);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const s = (v: unknown): string => String(v ?? '').trim();
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const me = await currentUser(client);
			const cl = (b['client'] ?? {}) as { contactId?: unknown; name?: unknown; phone?: unknown };
			const prevPay = data.payType ?? 'warranty';
			const prevCost = typeof data.cost === 'number' ? data.cost : null;
			// Перезаписываем редактируемые поля, сохраняем status/history/createdAt/createdBy.
			data.client = { contactId: Number(cl.contactId) || null, name: s(cl.name), phone: s(cl.phone) };
			data.device = s(b['device']);
			data.model = s(b['model']);
			data.serial = s(b['serial']);
			data.point = s(b['point']);
			data.appearance = s(b['appearance']);
			data.defect = s(b['defect']);
			data.payType = b['payType'] === 'paid' ? 'paid' : 'warranty';
			// Цену меняет только тот, кому разрешено; иначе оставляем прежнюю (warranty всё равно обнуляет).
			const reqCost = b['cost'] != null && b['cost'] !== '' && Number.isFinite(Number(b['cost'])) ? Number(b['cost']) : null;
			data.cost = data.payType !== 'paid' ? null : (me.canEditPrice ? reqCost : prevCost);
			data.comment = s(b['comment']);
			// Лог: если изменился вид/цена — пишем кто и что.
			data.history = Array.isArray(data.history) ? data.history : [];
			if (prevPay !== data.payType || prevCost !== data.cost) {
				const parts: string[] = [];
				if (prevPay !== data.payType) parts.push(`вид: ${data.payType === 'paid' ? 'платный' : 'гарантийный'}`);
				if (prevCost !== data.cost) parts.push(`цена: ${data.cost == null ? '—' : `${data.cost}₽`}`);
				data.history.push({ at: new Date().toISOString(), status: data.status, byId: me.id, byName: me.name, note: parts.join(', ') });
			}
			if (Array.isArray(b['photos'])) {
				data.photos = (b['photos'] as Array<Record<string, unknown>>).map((p) => ({ id: Number(p['id']) || 0, name: s(p['name']), url: s(p['url']) })).filter((p) => p.url);
			}
			if (Array.isArray(b['files'])) {
				data.files = (b['files'] as Array<Record<string, unknown>>).map((f) => ({ id: Number(f['id']) || 0, name: s(f['name']), url: s(f['url']), type: s(f['type']) })).filter((f) => f.url);
			}
			const name = [data.device, data.model, data.client.name].filter(Boolean).join(' · ') || 'Ремонт';
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id }, '[api/repairs/update] ok');
			return { ok: true, repair: { id, name, ...data }, canEditPrice: me.canEditPrice };
		} catch (err) {
			app.log.error({}, `[api/repairs/update] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Быстрая смена вида ремонта платный↔гарантийный (без захода в полное редактирование).
	// При переходе на платный можно сразу прислать стоимость; на гарантийный — стоимость обнуляется.
	app.post('/api/repairs/set-pay', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; payType?: unknown; cost?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const payType: 'warranty' | 'paid' = b.payType === 'paid' ? 'paid' : 'warranty';
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const me = await currentUser(client);
			const prevPay = data.payType ?? 'warranty';
			const prevCost = typeof data.cost === 'number' ? data.cost : null;
			data.payType = payType;
			// Серверный замок: цену задаёт только тот, кому разрешено; иначе держим прежнюю (warranty обнуляет).
			const reqCost = b.cost != null && b.cost !== '' && Number.isFinite(Number(b.cost)) ? Number(b.cost) : null;
			data.cost = payType !== 'paid' ? null : (me.canEditPrice ? reqCost : prevCost);
			data.history = Array.isArray(data.history) ? data.history : [];
			if (prevPay !== data.payType || prevCost !== data.cost) {
				const parts: string[] = [];
				if (prevPay !== data.payType) parts.push(`вид: ${data.payType === 'paid' ? 'платный' : 'гарантийный'}`);
				if (prevCost !== data.cost) parts.push(`цена: ${data.cost == null ? '—' : `${data.cost}₽`}`);
				data.history.push({ at: new Date().toISOString(), status: data.status, byId: me.id, byName: me.name, note: parts.join(', ') });
			}
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, payType, byPriceEditor: me.canEditPrice }, '[api/repairs/set-pay] ok');
			return { ok: true, payType: data.payType, cost: data.cost, canEditPrice: me.canEditPrice };
		} catch (err) {
			app.log.error({}, `[api/repairs/set-pay] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Удалить ремонт (наша запись в ctv_repairs). Необратимо; подтверждение — на фронте.
	app.post('/api/repairs/delete', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			await client.call('entity.item.delete', { ENTITY: REPAIRS_ENTITY, ID: id });
			app.log.info({ id }, '[api/repairs/delete] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ id }, `[api/repairs/delete] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Сменить статус ремонта (только вперёд/назад по нашей цепочке).
	app.post('/api/repairs/update-status', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; status?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		const status = String(b.status) as RepairStatus;
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		if (!STATUS_ORDER.includes(status)) return reply.code(400).send({ ok: false, error: 'bad status' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const me = await currentUser(client);
			data.status = status;
			data.history = Array.isArray(data.history) ? data.history : [];
			data.history.push({ at: new Date().toISOString(), status, byId: me.id, byName: me.name });
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, status }, '[api/repairs/update-status] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({}, `[api/repairs/update-status] failed — ${errInfo(err)}`);
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

	// Загрузка фото на Б24 Диск (хранилище приложения). Возвращает ссылку для карточки.
	// Best-effort: если Диск недоступен — фронт сохранит ремонт без фото.
	app.post('/api/repairs/upload-photo', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { fileName?: unknown; content?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const fileName = String(b.fileName ?? 'photo.jpg').replace(/[^\w.\-а-яё ]/gi, '_').slice(0, 80);
		const content = String(b.content ?? ''); // base64 без префикса data:
		if (!content) return reply.code(400).send({ ok: false, error: 'нет содержимого файла' });
		try {
			const storage = await client.call<{ ID?: number | string }>('disk.storage.getforapp', {});
			const storageId = Number(storage?.ID);
			if (!storageId) throw new Error('disk.storage.getforapp не вернул хранилище');
			const file = await client.call<Record<string, unknown>>('disk.storage.uploadfile', {
				id: storageId,
				data: { NAME: fileName },
				fileContent: [fileName, content],
				generateUniqueName: true,
			});
			const photo: RepairPhoto = {
				id: Number(file?.['ID']) || 0,
				name: String(file?.['NAME'] ?? fileName),
				url: String(file?.['DOWNLOAD_URL'] ?? file?.['DETAIL_URL'] ?? ''),
			};
			app.log.info({ id: photo.id }, '[api/repairs/upload-photo] ok');
			return { ok: true, photo };
		} catch (err) {
			app.log.warn({}, `[api/repairs/upload-photo] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
