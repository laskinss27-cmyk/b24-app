import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureRepairsEntity, REPAIRS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { receiveRepairUnit, renameRepairItem, moveRepairUnit, deliverRepairUnit, fetchErpStoreStockFull } from '../erp/operations.js';

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

// Два потока ремонта (kind):
//  client  — клиентский RMA: принято на ТТ → в офисе → в ремонт → на ТТ → готово к выдаче → выдано.
//  presale — предпродажный (наш товар со склада): в офисе → в ремонт → с ремонта в офис → на точку → принято на ТТ.
export type RepairKind = 'client' | 'presale';
export type RepairStatus =
	| 'received_tt' | 'received_office' | 'sent' | 'sent_to_tt' | 'ready_tt' | 'issued'   // клиентский
	| 'pre_office' | 'pre_sent' | 'pre_back_office' | 'pre_to_point' | 'pre_at_tt';        // предпродажный
const CLIENT_ORDER: RepairStatus[] = ['received_tt', 'received_office', 'sent', 'sent_to_tt', 'ready_tt', 'issued'];
const PRESALE_ORDER: RepairStatus[] = ['pre_office', 'pre_sent', 'pre_back_office', 'pre_to_point', 'pre_at_tt'];
const statusOrder = (kind: RepairKind): RepairStatus[] => kind === 'presale' ? PRESALE_ORDER : CLIENT_ORDER;

/** Со статуса «принято в офисе» КЛИЕНТСКАЯ карточка ЗАМОРОЖЕНА: правит только снабжение+ (canEditPrice).
 * Предпродажный не замораживаем (нет цен/клиента) — isLocked для его статусов вернёт false. */
const LOCK_FROM_INDEX = CLIENT_ORDER.indexOf('received_office');
function isLocked(s: RepairStatus): boolean {
	const i = CLIENT_ORDER.indexOf(s);
	return i >= 0 && i >= LOCK_FROM_INDEX;
}

/** Маппинг старых статусов (до разделения приёма ТТ/офис) на новые — чтобы прежние карточки не сломались. */
const LEGACY_STATUS: Record<string, RepairStatus> = {
	received: 'received_tt',
	sent: 'sent',
	returned: 'ready_tt',
	issued: 'issued',
};

function normalizeStatus(s: unknown, kind: RepairKind = 'client'): RepairStatus {
	const v = String(s ?? '');
	const order = statusOrder(kind);
	if (order.includes(v as RepairStatus)) return v as RepairStatus;
	if (kind === 'client' && LEGACY_STATUS[v]) return LEGACY_STATUS[v]!;
	return order[0]!;
}

/** Кто может РЕДАКТИРОВАТЬ цену ремонта: Вова(1), Сергей(1858), Бекасов(986) + отдел Снабжение(10).
 * Остальные цену видят, но не меняют. Б24 не отдаёт флаг «админ» на бэке — главные админы в списке поимённо. */
const PRICE_EDITOR_IDS = new Set(['1', '1858', '986']);
const PRICE_EDITOR_DEPTS = new Set([10]);
const SUPPLY_DEPT = 10;

let supplyHeadCache: number | null = null;
async function supplyHead(client: B24Client): Promise<number> {
	if (supplyHeadCache !== null) return supplyHeadCache;
	try {
		const deps = await client.call<Array<{ UF_HEAD?: unknown }>>('department.get', { ID: SUPPLY_DEPT });
		const head = Number((Array.isArray(deps) ? deps[0] : undefined)?.UF_HEAD ?? 0) || 0;
		supplyHeadCache = head;
		return head;
	} catch {
		supplyHeadCache = 0;
		return 0;
	}
}

/** Поле сделки «Название объекта» (обязательное). Б24 собирает имя сделки по шаблону {{ID}}_{{это поле}},
 * а TITLE напрямую переопределить нельзя — глобальное автоназвание затирает (проверено). Поэтому пишем
 * сюда «Платный ремонт №N · клиент · устройство» → имя сделки выходит осмысленным. Код поля портал-специфичен
 * (нашли через crm.deal.fields по заголовку «Название объекта»); сменят поле — имя просто станет «{ID}_». */
const DEAL_OBJECT_NAME_FIELD = 'UF_CRM_1750227509';

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
interface TaskSyncResult { taskId: number | null; error: string | null }

function repairNotifyTitle(data: RepairData, repairId: number): string {
	const repairTitle = data.kind === 'presale' ? 'Предпродажный ремонт' : 'Ремонт клиента';
	return `${repairTitle} #${data.repairNo || repairId}: ${[data.device, data.model].filter(Boolean).join(' ') || 'аппарат'}`;
}

function isFinishedRepair(data: RepairData): boolean {
	const kind = data.kind === 'presale' ? 'presale' : 'client';
	const status = normalizeStatus(data.status, kind);
	return kind === 'presale' ? status === 'pre_at_tt' : status === 'issued';
}

async function findRepairNotifyTask(client: B24Client, data: RepairData, repairId: number): Promise<number | null> {
	const title = repairNotifyTitle(data, repairId);
	const res = await client.call<{ tasks?: Array<{ id?: number | string; title?: string }> }>('tasks.task.list', {
		filter: { TITLE: title },
		select: ['ID', 'TITLE'],
		order: { ID: 'DESC' },
	});
	const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
	const exact = tasks.find((task) => String(task.title ?? '') === title) ?? tasks[0];
	return Number(exact?.id ?? 0) || null;
}

/** Текущий пользователь (по его токену) + право на правку цены. user.current отдаёт UF_DEPARTMENT. */
async function currentUser(client: B24Client): Promise<CurrentUser> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: unknown }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	const name = `${me?.NAME ?? ''} ${me?.LAST_NAME ?? ''}`.trim();
	const depts = Array.isArray(me?.UF_DEPARTMENT) ? (me?.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const canEditPrice = PRICE_EDITOR_IDS.has(id) || depts.some((d) => PRICE_EDITOR_DEPTS.has(d));
	return { id, name, canEditPrice };
}

async function createRepairNotifyTask(
	client: B24Client,
	data: RepairData,
	repairId: number,
	log: FastifyInstance['log'],
): Promise<TaskSyncResult> {
	try {
		const head = await supplyHead(client);
		const author = Number(data.createdById) || 0;
		const responsible = head || author;
		if (!responsible) return { taskId: null, error: 'не найден ответственный для задачи' };
		const accomplices = author && author !== responsible ? [author] : [];
		const repairTitle = data.kind === 'presale' ? 'Предпродажный ремонт' : 'Ремонт клиента';
		const pointLine = data.kind === 'presale'
			? `Склад-источник: ${data.sourceStore || 'не указан'}`
			: `ТТ приема: ${data.point || 'не указана'}`;
		const clientLine = data.kind === 'presale'
			? ''
			: `Клиент: ${[data.client.name, data.client.phone].filter(Boolean).join(' · ') || 'не указан'}\n`;
		const dealLine = data.dealId ? `Сделка ремонта: #${data.dealId}\n` : '';
		const body = [
			`${repairTitle} #${data.repairNo || repairId}`,
			`Запись ремонта: #${repairId}`,
			pointLine,
			clientLine.trim(),
			`Аппарат: ${[data.device, data.model].filter(Boolean).join(' ') || (data.productId ? `#${data.productId}` : 'не указан')}`,
			data.serial ? `Серийный номер: ${data.serial}` : '',
			data.defect ? `Неисправность: ${data.defect}` : '',
			data.appearance ? `Внешний вид/комплект: ${data.appearance}` : '',
			dealLine.trim(),
			`Принял: ${data.createdByName || (data.createdById ? `#${data.createdById}` : 'не указан')}`,
			'',
			'Открой раздел «Ремонты», проверь карточку и двигай ремонт по статусам.',
		].filter((line) => line !== '').join('\n');
		const task = await client.call<{ task?: { id?: number | string } }>('tasks.task.add', {
			fields: {
				TITLE: repairNotifyTitle(data, repairId),
				DESCRIPTION: body,
				RESPONSIBLE_ID: responsible,
				...(accomplices.length ? { ACCOMPLICES: accomplices } : {}),
			},
		});
		const taskId = Number(task?.task?.id ?? 0) || null;
		return { taskId, error: taskId ? null : 'Б24 не вернул ID задачи' };
	} catch (err) {
		const error = errInfo(err);
		log.warn({ repairId }, `[api/repairs] notify task failed — ${error}`);
		return { taskId: null, error };
	}
}

async function ensureRepairNotifyTask(
	client: B24Client,
	repair: RepairData & { id: number; name: string },
	log: FastifyInstance['log'],
): Promise<TaskSyncResult> {
	if (repair.taskId || isFinishedRepair(repair)) return { taskId: repair.taskId ?? null, error: null };
	const { id, name, ...data } = repair;
	try {
		const found = await findRepairNotifyTask(client, data, id);
		if (found) {
			data.taskId = found;
			repair.taskId = found;
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name || 'Ремонт', DETAIL_TEXT: JSON.stringify(data) });
			return { taskId: found, error: null };
		}
	} catch (err) {
		const error = errInfo(err);
		log.warn({ repairId: id }, `[api/repairs] legacy task lookup failed — ${error}`);
		return { taskId: null, error };
	}
	const created = await createRepairNotifyTask(client, data, id, log);
	if (created.taskId) {
		data.taskId = created.taskId;
		repair.taskId = created.taskId;
		await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name || 'Ремонт', DETAIL_TEXT: JSON.stringify(data) });
	}
	return created;
}

/** Авто-сделка по клиентскому ремонту. Создаётся ОДИН раз для ремонта с привязанным контактом:
 * у платного сумма = «наша цена», у гарантийного сумма = 0; dealId пишется в карточку → дубля нет.
 * Если вид/цена потом меняются — обновляем сумму и позицию у уже созданной сделки (best-effort). Без контакта не создаём.
 * Возвращает результат для подсказки на фронте. Мутирует data.dealId при создании. */
/** Воронка сделок «Ремонты» (entityTypeId=2). Резолвим по имени (кэш на процесс), создаём если нет.
 * Туда льём сделки ремонтов — отдельно от продаж и без робота-переименователя «Объектов».
 * undefined — ещё не выясняли; number — id; на ошибке не кэшируем (повторим позже). */
let repairsCategoryId: number | undefined;
async function ensureRepairsDealCategory(client: B24Client, log: FastifyInstance['log']): Promise<number | null> {
	if (repairsCategoryId !== undefined) return repairsCategoryId;
	try {
		const res = await client.call<{ categories?: Array<{ id: number | string; name: string }> }>('crm.category.list', { entityTypeId: 2 });
		const found = (res?.categories ?? []).find((c) => String(c.name).trim().toLowerCase() === 'ремонты');
		if (found) { repairsCategoryId = Number(found.id); return repairsCategoryId; }
		const added = await client.call<{ category?: { id?: number | string } } | number>('crm.category.add', { entityTypeId: 2, fields: { name: 'Ремонты' } });
		const id = typeof added === 'number' ? added : Number((added as { category?: { id?: number | string } })?.category?.id ?? 0);
		if (id > 0) { repairsCategoryId = id; log.info({ id }, '[repairs] воронка сделок «Ремонты» создана'); return id; }
		return null; // не вышло — не кэшируем, сделка уйдёт в общую воронку
	} catch (err) {
		log.warn({}, `[repairs] воронку «Ремонты» получить/создать не вышло — ${errInfo(err)}; сделка уйдёт в общую`);
		return null;
	}
}

interface DealSyncResult { dealId: number | null; created: boolean; noContact: boolean }
async function syncRepairDeal(client: B24Client, data: RepairData, log: FastifyInstance['log']): Promise<DealSyncResult> {
	// Сделка заводится на ЛЮБОЙ ремонт (даже гарантийный): сумма = «наша цена» у платного, 0 у гарантийного.
	const price = data.payType === 'paid' && typeof data.ourPrice === 'number' ? data.ourPrice : 0;
	const contactId = data.client?.contactId ?? null;
	const rowName = data.payType === 'paid' ? 'Платный ремонт' : 'Гарантийный ремонт';
	const rows = [{ PRODUCT_NAME: rowName, PRICE: price, QUANTITY: 1 }]; // свободная строка (PRODUCT_ID:0) — каталог не трогаем; номер ремонта — в названии сделки
	const repairKind = data.payType === 'paid' ? 'Платный ремонт' : 'Гарантийный ремонт';
	const objectName = [`${repairKind} №${data.repairNo}`, data.client?.name, [data.device, data.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
	if (data.dealId) {
		// Сделка уже есть — подтянуть сумму/позицию под новую цену (best-effort, не валим запрос ремонта).
		try {
			await client.call('crm.deal.update', { id: data.dealId, fields: { TITLE: objectName, OPPORTUNITY: price, [DEAL_OBJECT_NAME_FIELD]: objectName } });
			await client.call('crm.deal.productrows.set', { id: data.dealId, rows });
		} catch (err) { log.warn({}, `[repairs] обновление сделки ${data.dealId} не удалось — ${errInfo(err)}`); }
		return { dealId: data.dealId, created: false, noContact: false };
	}
	if (!contactId) return { dealId: null, created: false, noContact: true }; // не на кого вешать
	try {
		// Имя сделки Б24 собирает как {{ID}}_{{Название объекта}} → кладём осмысленное в поле «Название объекта».
		const categoryId = await ensureRepairsDealCategory(client, log);
		const fields: Record<string, unknown> = { TITLE: objectName, CONTACT_ID: contactId, OPPORTUNITY: price, CURRENCY_ID: 'RUB', [DEAL_OBJECT_NAME_FIELD]: objectName };
		if (categoryId) fields['CATEGORY_ID'] = categoryId; // отдельная воронка «Ремонты»
		const added = await client.call<number | { id?: number }>('crm.deal.add', { fields });
		const did = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
		if (!did) throw new Error('crm.deal.add не вернул id');
		await client.call('crm.deal.productrows.set', { id: did, rows }).catch((e) => log.warn({}, `[repairs] productrows.set сделки ${did} — ${errInfo(e)}`));
		data.dealId = did;
		log.info({ dealId: did, repairNo: data.repairNo, payType: data.payType }, '[repairs] сделка по ремонту создана');
		return { dealId: did, created: true, noContact: false };
	} catch (err) {
		log.error({}, `[repairs] создание сделки не удалось — ${errInfo(err)}`);
		return { dealId: null, created: false, noContact: false };
	}
}

/** Офисный склад (хардкод — решение Сергея): в него аппарат едет при «принято в офисе». */
const OFFICE_STORE = 'Измайловский 18Д';
/** Транзитный склад ядра — пока аппарат в ремонте / в пути. */
const TRANSIT_STORE = 'Goods In Transit';

/** Имя позиции ремонтного аппарата на складе: `[ремонт]<оборуд. модель> s/n <серийник> <ФИО клиента>`. */
function buildRepairItemName(data: RepairData): string {
	const head = [data.device, data.model].map((s) => s.trim()).filter(Boolean).join(' ');
	const sn = data.serial.trim() ? ` s/n ${data.serial.trim()}` : '';
	const who = data.client?.name?.trim() ? ` ${data.client.name.trim()}` : '';
	return `[ремонт]${head}${sn}${who}`.trim();
}

/** Разложить «Иванов Иван Иваныч» на поля контакта Б24. ≥2 слов → Фамилия/Имя/Отчество; 1 слово → Имя. */
function splitFio(fio: string): { LAST_NAME: string; NAME: string; SECOND_NAME: string } {
	const parts = fio.trim().split(/\s+/).filter(Boolean);
	if (parts.length >= 2) return { LAST_NAME: parts[0]!, NAME: parts[1]!, SECOND_NAME: parts.slice(2).join(' ') };
	return { LAST_NAME: '', NAME: parts[0] ?? '', SECOND_NAME: '' };
}

/** Клиент ремонта = контакт Б24. Уже привязан → берём; иначе ищем по телефону (Б24 не даст дубль с тем же
 *  номером) и при отсутствии заводим новый контакт с телефоном. Возвращает id (null — не вышло/нет данных). */
async function resolveOrCreateContact(
	client: B24Client,
	args: { contactId: number | null; name: string; phone: string },
	log: FastifyInstance['log'],
): Promise<number | null> {
	if (args.contactId && args.contactId > 0) return args.contactId;
	const phone = args.phone.trim();
	const name = args.name.trim();
	if (!name) return null;
	// Поиск по телефону — чтобы не плодить дубли (и Б24 всё равно не создаст контакт с занятым номером).
	if (phone) {
		try {
			const dup = await client.call<{ CONTACT?: Array<number | string> }>('crm.duplicate.findbycomm', { type: 'PHONE', values: [phone], entity_type: 'CONTACT' });
			const found = Number((dup?.CONTACT ?? [])[0] ?? 0);
			if (found > 0) return found;
		} catch (err) { log.warn({}, `[repairs] поиск контакта по телефону не вышел — ${errInfo(err)}`); }
	}
	try {
		const fields: Record<string, unknown> = { ...splitFio(name) };
		if (phone) fields['PHONE'] = [{ VALUE: phone, VALUE_TYPE: 'WORK' }];
		const added = await client.call<number | { id?: number }>('crm.contact.add', { fields });
		const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
		if (id > 0) { log.info({ contactId: id }, '[repairs] создан контакт клиента'); return id; }
	} catch (err) { log.error({}, `[repairs] создание контакта не удалось — ${errInfo(err)}`); }
	return null;
}

/** Материализовать ремонт на складе ЯДРА: позиция `[ремонт]…` + приход 1 шт на склад точки приёмки.
 *  Создаётся ОДИН раз (по отсутствию repairItemCode); при правке — только переименование (не плодим позиции).
 *  Best-effort: ядро недоступно/без точки приёмки — ремонт всё равно сохраняется. Мутирует data.repairItemCode. */
async function syncRepairStock(data: RepairData, log: FastifyInstance['log'], opts: { allowCreate: boolean } = { allowCreate: true }): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!erp) return; // ядро не сконфигурировано — фича оживёт при переключении склада на ядро
	const itemName = buildRepairItemName(data);
	try {
		if (data.repairItemCode) {
			await renameRepairItem(erp, { itemCode: data.repairItemCode, itemName });
			return;
		}
		// Заводим позицию ТОЛЬКО при приёмке. На правке старого ремонта (без кода) не создаём — иначе
		// оприходуем на склад давно закрытые ремонты.
		if (!opts.allowCreate) return;
		const store = data.point.trim();
		if (!store) { log.warn({ repairNo: data.repairNo }, '[repairs] склад приёмки (точка) не указан — позиция на складе не заведена'); return; }
		const itemCode = `REPAIR-${data.repairNo}`;
		await receiveRepairUnit(erp, { itemCode, itemName, storeTitle: store });
		data.repairItemCode = itemCode;
		data.repairStore = store; // аппарат теперь лежит на складе точки приёмки
		log.info({ itemCode, store }, '[repairs] позиция ремонта заведена на складе ядра');
	} catch (err) {
		log.warn({ repairNo: data.repairNo }, `[repairs] склад ядра: позицию завести/переименовать не вышло — ${errInfo(err)}`);
	}
}

/** Движение позиции по смене статуса (этап 2). Best-effort; мутирует data.repairStore.
 *  Только вперёд: откат статуса остаток не двигает (ограничение v1). Карта:
 *   принято в офисе → Измайловский · отправлено в ремонт → транзит · отправлено на ТТ → без движения (в пути)
 *   готово к выдаче → склад выдачи · выдано → склад не трогаем (дальше работа в сделке). */
async function moveRepairForStatus(data: RepairData, newStatus: RepairStatus, log: FastifyInstance['log']): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!erp || !data.repairItemCode) return;
	const target = newStatus === 'received_office' ? OFFICE_STORE
		: newStatus === 'sent' ? TRANSIT_STORE
		: newStatus === 'ready_tt' ? (data.issueStore?.trim() || null)
		: null;
	if (!target) {
		if (newStatus === 'ready_tt') log.warn({ repairNo: data.repairNo }, '[repairs] «готово к выдаче» без склада выдачи — перемещение не сделано');
		return;
	}
	const from = data.repairStore?.trim();
	if (!from) { log.warn({ repairNo: data.repairNo }, '[repairs] текущий склад позиции неизвестен — перемещение пропущено'); return; }
	if (from === target) { data.repairStore = target; return; } // уже там (напр. приняли сразу в офисе)
	try {
		await moveRepairUnit(erp, { itemCode: data.repairItemCode, fromStore: from, toStore: target });
		data.repairStore = target;
		log.info({ itemCode: data.repairItemCode, from, to: target }, '[repairs] позиция перемещена по статусу');
	} catch (err) {
		log.warn({ repairNo: data.repairNo }, `[repairs] перемещение позиции (${from}→${target}) не вышло — ${errInfo(err)}`);
	}
}

/** Списание аппарата при «Выдано» (клиентский): Delivery Note в ядре, цена 0 (выдаём владельцу, не продаём),
 *  привязка к сделке → виден в её реализациях. Идемпотентно (по repairDeliveryNote), best-effort. */
async function writeOffRepairOnIssue(data: RepairData, log: FastifyInstance['log']): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!erp || !data.repairItemCode || data.repairDeliveryNote) return;
	const store = data.repairStore?.trim();
	if (!store) { log.warn({ repairNo: data.repairNo }, '[repairs] выдача: склад аппарата неизвестен — списание пропущено'); return; }
	try {
		const dn = await deliverRepairUnit(erp, { itemCode: data.repairItemCode, storeTitle: store, ...(data.dealId ? { dealId: data.dealId } : {}) });
		data.repairDeliveryNote = dn.name;
		data.repairStore = null; // аппарат выдан — со склада списан
		log.info({ itemCode: data.repairItemCode, dn: dn.name }, '[repairs] аппарат списан при выдаче (Delivery Note)');
	} catch (err) {
		log.warn({ repairNo: data.repairNo }, `[repairs] списание при выдаче не вышло — ${errInfo(err)}`);
	}
}

/** ПРЕДПРОДАЖНЫЙ: движение существующего товара (productId) по статусам. Best-effort; мутирует repairStore.
 *  Карта: принято в офисе→Измайловский · отправлено в ремонт→транзит · принято с ремонта в офис→Измайловский ·
 *  отправлено на точку→транзит (нужен склад точки = issueStore) · принято на ТТ→склад точки (issueStore). */
async function movePresaleForStatus(data: RepairData, newStatus: RepairStatus, log: FastifyInstance['log']): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!erp || !data.productId) return;
	const target = newStatus === 'pre_office' ? OFFICE_STORE
		: newStatus === 'pre_sent' ? TRANSIT_STORE
		: newStatus === 'pre_back_office' ? OFFICE_STORE
		: newStatus === 'pre_to_point' ? TRANSIT_STORE
		: newStatus === 'pre_at_tt' ? (data.issueStore?.trim() || null)
		: null;
	if (!target) {
		if (newStatus === 'pre_at_tt') log.warn({ repairNo: data.repairNo }, '[repairs] предпродажный «принято на ТТ» без склада точки — перемещение не сделано');
		return;
	}
	const from = data.repairStore?.trim();
	if (!from) { log.warn({ repairNo: data.repairNo }, '[repairs] предпродажный: текущий склад неизвестен — перемещение пропущено'); return; }
	if (from === target) { data.repairStore = target; return; }
	try {
		await moveRepairUnit(erp, { itemCode: String(data.productId), fromStore: from, toStore: target });
		data.repairStore = target;
		log.info({ productId: data.productId, from, to: target }, '[repairs] предпродажный: товар перемещён по статусу');
	} catch (err) {
		log.warn({ repairNo: data.repairNo }, `[repairs] предпродажное перемещение (${from}→${target}) не вышло — ${errInfo(err)}`);
	}
}

interface RepairPhoto { id: number; name: string; url: string }
/** Прикреплённый документ (Word/Excel/PDF) — хранится на Диске Б24, в карточке только ссылка. */
interface RepairFile { id: number; name: string; url: string; type: string }

interface RepairData {
	/** Поток ремонта: 'client' (клиентский RMA) | 'presale' (предпродажный — наш товар со склада). */
	kind: RepairKind;
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
	/** Цена ремонта СЦ — что берёт сервисный центр (только для платных; у гарантийных null). */
	cost: number | null;
	/** Наша цена — что берём с клиента (только для платных; основа суммы сделки). */
	ourPrice: number | null;
	/** ID созданной по ремонту сделки Б24 (чтобы не задваивать; null — ещё не создана). */
	dealId: number | null;
	/** ID задачи Б24 для снабжения/автора по этому ремонту. */
	taskId: number | null;
	/** Код позиции ремонтного аппарата на складе ядра (`REPAIR-<номер>`; null — ещё не заведена). */
	repairItemCode: string | null;
	/** Где аппарат лежит сейчас (название склада Б24) — чтобы перемещать «откуда» при смене статуса. */
	repairStore: string | null;
	/** Склад выдачи — куда переместить при «Готово к выдаче». Задаётся позже (когда отремонтировали), не при приёмке. */
	issueStore: string | null;
	/** Имя проведённого Delivery Note списания при «Выдано» (идемпотентность; null — ещё не списан). */
	repairDeliveryNote: string | null;
	/** ПРЕДПРОДАЖНЫЙ: productId существующего товара каталога, который отправили в ремонт (двигаем его). */
	productId: number | null;
	/** ПРЕДПРОДАЖНЫЙ: склад-источник, откуда товар ушёл в ремонт (для справки). */
	sourceStore: string | null;
	/** Комментарий сервисного центра (диагностика/итог ремонта) — заполняется после возврата. */
	comment: string;
	/** Внутренний комментарий по ремонту: виден в карточке и списке, в печатный акт не попадает. */
	internalComment: string;
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
	const kind: RepairKind = data.kind === 'presale' ? 'presale' : 'client';
	return {
		id,
		name: String(it['NAME'] ?? ''),
		kind,
		status: normalizeStatus(data.status, kind),
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
		ourPrice: payType === 'paid' && typeof data.ourPrice === 'number' ? data.ourPrice : null,
		dealId: typeof data.dealId === 'number' && data.dealId > 0 ? data.dealId : null,
		taskId: typeof data.taskId === 'number' && data.taskId > 0 ? data.taskId : null,
		repairItemCode: typeof data.repairItemCode === 'string' && data.repairItemCode ? data.repairItemCode : null,
		repairStore: typeof data.repairStore === 'string' && data.repairStore ? data.repairStore : null,
		issueStore: typeof data.issueStore === 'string' && data.issueStore ? data.issueStore : null,
		repairDeliveryNote: typeof data.repairDeliveryNote === 'string' && data.repairDeliveryNote ? data.repairDeliveryNote : null,
		productId: typeof data.productId === 'number' && data.productId > 0 ? data.productId : null,
		sourceStore: typeof data.sourceStore === 'string' && data.sourceStore ? data.sourceStore : null,
		comment: data.comment ?? '',
		internalComment: data.internalComment ?? '',
		photos: Array.isArray(data.photos) ? data.photos : [],
		files: Array.isArray(data.files) ? data.files : [],
		createdAt: data.createdAt ?? '',
		createdById: data.createdById ?? '',
		createdByName: data.createdByName ?? '',
		history: Array.isArray(data.history) ? data.history : [],
	};
}

/** Прочитать ВСЕ записи ctv_repairs постранично. entity.item.get отдаёт ~50 за раз — без пагинации
 * скан номеров (и список) теряет свежие ремонты при >50 записей (отсюда был дубль repairNo). Если
 * портал не поддерживает `start` (та же первая запись повторно) — выходим, чтобы не зациклиться. */
async function fetchAllRepairs(client: B24Client): Promise<Array<Record<string, unknown>>> {
	const all: Array<Record<string, unknown>> = [];
	let start = 0;
	let prevFirstId: string | null = null;
	for (let page = 0; page < 40; page++) {
		const batch = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, SORT: { ID: 'DESC' }, start });
		const items = Array.isArray(batch) ? batch : [];
		if (!items.length) break;
		const firstId = String(items[0]?.['ID'] ?? '');
		if (firstId === prevFirstId) break; // `start` не поддержан — та же страница, дальше не идём
		prevFirstId = firstId;
		all.push(...items);
		if (items.length < 50) break;
		start += items.length;
	}
	return all;
}

/** Свой номер ремонта (со 100, дальше max+1) — общий для обоих потоков. На сбое скана — уникальный по времени
 *  (фикс.100 плодил дубли). Гонка при одновременном создании маловероятна для канарейки. */
async function assignRepairNo(client: B24Client, log: FastifyInstance['log']): Promise<number> {
	try {
		const existing = await fetchAllRepairs(client);
		let max = 99, withNo = 0;
		for (const it of existing) {
			try { const d = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as { repairNo?: unknown }) : {}; const n = Number(d.repairNo); if (Number.isFinite(n) && n > 0) { withNo++; if (n > max) max = n; } } catch { /* битая запись */ }
		}
		const assigned = max + 1;
		log.info({ scanned: existing.length, withRepairNo: withNo, maxRepairNo: max, assigned }, '[api/repairs] номер присвоен');
		return assigned;
	} catch (err) {
		const rn = 100 + (Date.now() % 100000);
		log.error({ repairNo: rn }, `[api/repairs] скан номеров упал, присвоен уникальный по времени — ${errInfo(err)}`);
		return rn;
	}
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
			const items = await fetchAllRepairs(client); // ВСЕ записи постранично — чтобы список не обрезался на 50
			const repairs = items.map(parseItem).filter((r): r is RepairData & { id: number; name: string } => r != null);
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
			for (const r of repairs) {
				if (r.taskId || isFinishedRepair(r)) continue;
				await ensureRepairNotifyTask(client, r, app.log);
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
		// Клиент обязателен для любого ремонта (платный/гарантийный): на него вешаем сделку и подписываем позицию склада.
		if (!clientName) return reply.code(400).send({ ok: false, error: 'клиент обязателен — укажи ФИО или организацию' });

		const photos: RepairPhoto[] = Array.isArray(b['photos'])
			? (b['photos'] as Array<Record<string, unknown>>).map((p) => ({ id: Number(p['id']) || 0, name: s(p['name']), url: s(p['url']) })).filter((p) => p.url)
			: [];
		const files: RepairFile[] = Array.isArray(b['files'])
			? (b['files'] as Array<Record<string, unknown>>).map((f) => ({ id: Number(f['id']) || 0, name: s(f['name']), url: s(f['url']), type: s(f['type']) })).filter((f) => f.url)
			: [];
		const payType: 'warranty' | 'paid' = b['payType'] === 'paid' ? 'paid' : 'warranty';
		const reqCost = payType === 'paid' && b['cost'] != null && b['cost'] !== '' && Number.isFinite(Number(b['cost'])) ? Number(b['cost']) : null;
		const reqOur = payType === 'paid' && b['ourPrice'] != null && b['ourPrice'] !== '' && Number.isFinite(Number(b['ourPrice'])) ? Number(b['ourPrice']) : null;
		try {
			const me = await currentUser(client);
			const byId = me.id;
			const byName = me.name;
			const cost = me.canEditPrice ? reqCost : null; // цену проставит только тот, кому разрешено
			const ourPrice = me.canEditPrice ? reqOur : null;
			const now = new Date().toISOString();
			const cl = (b['client'] ?? {}) as { contactId?: unknown; name?: unknown; phone?: unknown };
			// Клиент = контакт Б24: берём привязанный / находим по телефону / заводим нового (с телефоном).
			const contactId = await resolveOrCreateContact(client, { contactId: Number(cl.contactId) || null, name: s(cl.name), phone: s(cl.phone) }, app.log);

			const repairNo = await assignRepairNo(client, app.log);

			const data: RepairData = {
				kind: 'client',
				status: 'received_tt',
				repairNo,
				client: { contactId, name: s(cl.name), phone: s(cl.phone) },
				device,
				model: s(b['model']),
				serial: s(b['serial']),
				point: s(b['point']),
				appearance: s(b['appearance']),
				defect: s(b['defect']),
				payType,
				cost,
				ourPrice,
				dealId: null,
				taskId: null,
				repairItemCode: null,
				repairStore: null,
				issueStore: null,
				repairDeliveryNote: null,
				productId: null,
				sourceStore: null,
				// Комментарий СЦ заполняет/правит только снабжение+ (у менеджеров поле неактивно).
				comment: me.canEditPrice ? s(b['comment']) : '',
				internalComment: s(b['internalComment']),
				photos,
				files,
				createdAt: now,
				createdById: byId,
				createdByName: byName,
				history: [{ at: now, status: 'received_tt', byId, byName }],
			};
			// Сделка — на любой ремонт (пишет data.dealId). Затем позиция аппарата на складе ядра (пишет data.repairItemCode).
			const dealSync = await syncRepairDeal(client, data, app.log);
			await syncRepairStock(data, app.log);
			const nameParts = [device, data.model, data.client.name].filter(Boolean);
			const added = await client.call<number | { id?: number }>('entity.item.add', {
				ENTITY: REPAIRS_ENTITY,
				NAME: nameParts.join(' · ') || 'Ремонт',
				DETAIL_TEXT: JSON.stringify(data),
			});
			const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!id) throw new Error('entity.item.add не вернул id');
			const taskSync = await createRepairNotifyTask(client, data, id, app.log);
			if (taskSync.taskId) {
				data.taskId = taskSync.taskId;
				await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: nameParts.join(' · ') || 'Ремонт', DETAIL_TEXT: JSON.stringify(data) });
			}
			app.log.info({ id }, '[api/repairs/create] ok');
			return { ok: true, id, repair: { id, name: nameParts.join(' · '), ...data }, canEditPrice: me.canEditPrice, dealCreated: dealSync.created, dealNoContact: dealSync.noContact, taskCreated: Boolean(taskSync.taskId), taskError: taskSync.error };
		} catch (err) {
			app.log.error({}, `[api/repairs/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Остатки склада из ядра — пикер аппарата для предпродажного (выбираем товар со склада-источника).
	// Ремонтные позиции (строковый код) сюда не попадают — fetchErpStoreStockFull берёт только числовые коды.
	app.post('/api/repairs/store-stock', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { store?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const store = String(b.store ?? '').trim();
		if (!store) return reply.code(400).send({ ok: false, error: 'не указан склад' });
		try {
			const rows = await fetchErpStoreStockFull(erp, store);
			return { ok: true, items: rows.map((r) => ({ productId: r.productId, name: r.name, qty: r.book })) };
		} catch (err) {
			app.log.error({}, `[api/repairs/store-stock] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Принять в ПРЕДПРОДАЖНЫЙ ремонт: наш товар со склада-источника (productId из остатков) уходит в ремонт.
	// Без клиента/цен/сделки. Создаётся в статусе «принято в офисе» + перемещение источник→Измайловский.
	app.post('/api/repairs/create-presale', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { sourceStore?: unknown; productId?: unknown; itemName?: unknown; internalComment?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const s = (v: unknown): string => String(v ?? '').trim();
		const sourceStore = s(b['sourceStore']);
		const productId = Number(b['productId']);
		const itemName = s(b['itemName']);
		if (!sourceStore) return reply.code(400).send({ ok: false, error: 'не выбран склад-источник' });
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'не выбран аппарат' });
		try {
			const me = await currentUser(client);
			const now = new Date().toISOString();
			const repairNo = await assignRepairNo(client, app.log);
			const data: RepairData = {
				kind: 'presale',
				status: 'pre_office',
				repairNo,
				client: { contactId: null, name: '', phone: '' },
				device: itemName, model: '', serial: '', point: '',
				appearance: '', defect: '',
				payType: 'warranty', cost: null, ourPrice: null, dealId: null,
				taskId: null,
				repairItemCode: null,
				repairStore: sourceStore, // товар сейчас на источнике; первый статус сдвинет в офис
				issueStore: null,
				repairDeliveryNote: null,
				productId, sourceStore,
				comment: '',
				internalComment: s(b['internalComment']),
				photos: [], files: [],
				createdAt: now, createdById: me.id, createdByName: me.name,
				history: [{ at: now, status: 'pre_office', byId: me.id, byName: me.name }],
			};
			// «Принято в офисе» — перемещаем товар источник → Измайловский (мутирует repairStore).
			await movePresaleForStatus(data, 'pre_office', app.log);
			const name = (`[предпродажа] ${itemName}`).slice(0, 120) || 'Предпродажный ремонт';
			const added = await client.call<number | { id?: number }>('entity.item.add', { ENTITY: REPAIRS_ENTITY, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			const newId = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!newId) throw new Error('entity.item.add не вернул id');
			const taskSync = await createRepairNotifyTask(client, data, newId, app.log);
			if (taskSync.taskId) {
				data.taskId = taskSync.taskId;
				await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: newId, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			}
			app.log.info({ id: newId, productId, sourceStore }, '[api/repairs/create-presale] ok');
			return { ok: true, id: newId, repair: { id: newId, name, ...data }, taskCreated: Boolean(taskSync.taskId), taskError: taskSync.error };
		} catch (err) {
			app.log.error({}, `[api/repairs/create-presale] failed — ${errInfo(err)}`);
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
			// Заморозка с «принято в офисе»: правит только снабжение+.
			if (isLocked(normalizeStatus(data.status)) && !me.canEditPrice) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — изменять может только снабжение' });
			}
			const cl = (b['client'] ?? {}) as { contactId?: unknown; name?: unknown; phone?: unknown };
			const prevPay = data.payType ?? 'warranty';
			const prevCost = typeof data.cost === 'number' ? data.cost : null;
			const prevOur = typeof data.ourPrice === 'number' ? data.ourPrice : null;
			// Перезаписываем редактируемые поля, сохраняем status/history/createdAt/createdBy.
			const contactId = await resolveOrCreateContact(client, { contactId: Number(cl.contactId) || null, name: s(cl.name), phone: s(cl.phone) }, app.log);
			data.client = { contactId, name: s(cl.name), phone: s(cl.phone) };
			data.device = s(b['device']);
			data.model = s(b['model']);
			data.serial = s(b['serial']);
			data.point = s(b['point']);
			data.appearance = s(b['appearance']);
			data.defect = s(b['defect']);
			data.internalComment = s(b['internalComment']);
			data.payType = b['payType'] === 'paid' ? 'paid' : 'warranty';
			// Цены меняет только тот, кому разрешено; иначе оставляем прежние (warranty всё обнуляет).
			const reqCost = b['cost'] != null && b['cost'] !== '' && Number.isFinite(Number(b['cost'])) ? Number(b['cost']) : null;
			const reqOur = b['ourPrice'] != null && b['ourPrice'] !== '' && Number.isFinite(Number(b['ourPrice'])) ? Number(b['ourPrice']) : null;
			data.cost = data.payType !== 'paid' ? null : (me.canEditPrice ? reqCost : prevCost);
			data.ourPrice = data.payType !== 'paid' ? null : (me.canEditPrice ? reqOur : prevOur);
			// Комментарий СЦ правит только снабжение+; у менеджера держим прежний.
			data.comment = me.canEditPrice ? s(b['comment']) : (data.comment ?? '');
			// Лог: если изменился вид/цены — пишем кто и что.
			data.history = Array.isArray(data.history) ? data.history : [];
			if (prevPay !== data.payType || prevCost !== data.cost || prevOur !== data.ourPrice) {
				const parts: string[] = [];
				if (prevPay !== data.payType) parts.push(`вид: ${data.payType === 'paid' ? 'платный' : 'гарантийный'}`);
				if (prevCost !== data.cost) parts.push(`цена СЦ: ${data.cost == null ? '—' : `${data.cost}₽`}`);
				if (prevOur !== data.ourPrice) parts.push(`наша цена: ${data.ourPrice == null ? '—' : `${data.ourPrice}₽`}`);
				data.history.push({ at: new Date().toISOString(), status: data.status, byId: me.id, byName: me.name, note: parts.join(', ') });
			}
			// Сделку держим в актуальном (мутирует data.dealId); позицию склада переименовываем вслед за карточкой.
			const dealSync = await syncRepairDeal(client, data, app.log);
			await syncRepairStock(data, app.log, { allowCreate: false });
			if (Array.isArray(b['photos'])) {
				data.photos = (b['photos'] as Array<Record<string, unknown>>).map((p) => ({ id: Number(p['id']) || 0, name: s(p['name']), url: s(p['url']) })).filter((p) => p.url);
			}
			if (Array.isArray(b['files'])) {
				data.files = (b['files'] as Array<Record<string, unknown>>).map((f) => ({ id: Number(f['id']) || 0, name: s(f['name']), url: s(f['url']), type: s(f['type']) })).filter((f) => f.url);
			}
			const name = [data.device, data.model, data.client.name].filter(Boolean).join(' · ') || 'Ремонт';
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id }, '[api/repairs/update] ok');
			return { ok: true, repair: { id, name, ...data }, canEditPrice: me.canEditPrice, dealCreated: dealSync.created, dealNoContact: dealSync.noContact };
		} catch (err) {
			app.log.error({}, `[api/repairs/update] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Быстрая смена вида ремонта платный↔гарантийный (без захода в полное редактирование).
	// При переходе на платный можно сразу прислать стоимость; на гарантийный — стоимость обнуляется.
	app.post('/api/repairs/set-pay', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; payType?: unknown; cost?: unknown; ourPrice?: unknown };
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
			// Заморозка с «принято в офисе»: правит только снабжение+.
			if (isLocked(normalizeStatus(data.status)) && !me.canEditPrice) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — изменять может только снабжение' });
			}
			const prevPay = data.payType ?? 'warranty';
			const prevCost = typeof data.cost === 'number' ? data.cost : null;
			const prevOur = typeof data.ourPrice === 'number' ? data.ourPrice : null;
			data.payType = payType;
			// Серверный замок: цены задаёт только тот, кому разрешено; иначе держим прежние (warranty обнуляет).
			const reqCost = b.cost != null && b.cost !== '' && Number.isFinite(Number(b.cost)) ? Number(b.cost) : null;
			const reqOur = b.ourPrice != null && b.ourPrice !== '' && Number.isFinite(Number(b.ourPrice)) ? Number(b.ourPrice) : null;
			data.cost = payType !== 'paid' ? null : (me.canEditPrice ? reqCost : prevCost);
			data.ourPrice = payType !== 'paid' ? null : (me.canEditPrice ? reqOur : prevOur);
			data.history = Array.isArray(data.history) ? data.history : [];
			if (prevPay !== data.payType || prevCost !== data.cost || prevOur !== data.ourPrice) {
				const parts: string[] = [];
				if (prevPay !== data.payType) parts.push(`вид: ${data.payType === 'paid' ? 'платный' : 'гарантийный'}`);
				if (prevCost !== data.cost) parts.push(`цена СЦ: ${data.cost == null ? '—' : `${data.cost}₽`}`);
				if (prevOur !== data.ourPrice) parts.push(`наша цена: ${data.ourPrice == null ? '—' : `${data.ourPrice}₽`}`);
				data.history.push({ at: new Date().toISOString(), status: data.status, byId: me.id, byName: me.name, note: parts.join(', ') });
			}
			// Сделка нужна и платному, и гарантийному ремонту: у гарантийного сумма будет 0.
			const dealSync = await syncRepairDeal(client, data, app.log);
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, payType, byPriceEditor: me.canEditPrice }, '[api/repairs/set-pay] ok');
			return { ok: true, payType: data.payType, cost: data.cost, ourPrice: data.ourPrice, dealId: data.dealId, canEditPrice: me.canEditPrice, dealCreated: dealSync.created, dealNoContact: dealSync.noContact };
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
			// Заморозка: принятый в офисе ремонт удаляет только снабжение+.
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (raw) {
				const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
				const me = await currentUser(client);
				if (isLocked(normalizeStatus(data.status)) && !me.canEditPrice) {
					return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — удалить может только снабжение' });
				}
			}
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
		if (![...CLIENT_ORDER, ...PRESALE_ORDER].includes(status)) return reply.code(400).send({ ok: false, error: 'bad status' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const kind: RepairKind = data.kind === 'presale' ? 'presale' : 'client';
			if (!statusOrder(kind).includes(status)) return reply.code(400).send({ ok: false, error: 'статус не из цепочки этого ремонта' });
			const me = await currentUser(client);
			// Заморозка (только клиентский): с «принято в офисе» двигать статус может только снабжение+.
			// presale не замораживаем — isLocked для его статусов = false.
			if (isLocked(normalizeStatus(data.status, kind)) && !me.canEditPrice) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — статус двигает только снабжение' });
			}
			data.status = status;
			data.history = Array.isArray(data.history) ? data.history : [];
			data.history.push({ at: new Date().toISOString(), status, byId: me.id, byName: me.name });
			// Движение по новому статусу — своё для каждого потока (мутирует data.repairStore).
			if (kind === 'presale') {
				await movePresaleForStatus(data, status, app.log);
			} else {
				await moveRepairForStatus(data, status, app.log);
				// «Выдано» — списываем аппарат со склада (Delivery Note ядра, цена 0, привязка к сделке).
				if (status === 'issued') await writeOffRepairOnIssue(data, app.log);
			}
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, status }, '[api/repairs/update-status] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({}, `[api/repairs/update-status] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Установить склад выдачи (задаётся ближе к выдаче, на странице просмотра). Гейт заморозки: после
	// «принято в офисе» меняет только снабжение+. Сам остаток двигает статус «Готово к выдаче».
	app.post('/api/repairs/set-issue-store', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; issueStore?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const issueStore = String(b.issueStore ?? '').trim();
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const me = await currentUser(client);
			if (isLocked(normalizeStatus(data.status)) && !me.canEditPrice) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — склад выдачи задаёт снабжение' });
			}
			data.issueStore = issueStore || null;
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, issueStore }, '[api/repairs/set-issue-store] ok');
			return { ok: true, issueStore: data.issueStore };
		} catch (err) {
			app.log.error({}, `[api/repairs/set-issue-store] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

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
