import type { FastifyInstance } from 'fastify';
import { B24ApiError } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { deliverRepairUnit, locateRepairUnit, moveRepairUnit, receiveRepairUnit, renameRepairItem } from '../erp/operations.js';
import type { RepairData } from './repair-record.js';
import type { RepairStatus } from './repair-status.js';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
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

/** Материализовать ремонт на складе ЯДРА: позиция `[ремонт]…` + приход 1 шт на склад точки приёмки.
 *  Создаётся ОДИН раз (по отсутствию repairItemCode); при правке — только переименование (не плодим позиции).
 *  Best-effort: ядро недоступно/без точки приёмки — ремонт всё равно сохраняется. Мутирует data.repairItemCode. */
export async function syncRepairStock(data: RepairData, log: FastifyInstance['log'], opts: { allowCreate: boolean } = { allowCreate: true }): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!erp) {
		if (opts.allowCreate) throw new Error('ядро склада недоступно — ремонт не принят');
		return;
	}
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
		if (!store) throw new Error('склад приёмки не указан — ремонт не принят');
		const itemCode = `REPAIR-${data.repairNo}`;
		await receiveRepairUnit(erp, { itemCode, itemName, storeTitle: store });
		data.repairItemCode = itemCode;
		data.repairStore = store; // аппарат теперь лежит на складе точки приёмки
		log.info({ itemCode, store }, '[repairs] позиция ремонта заведена на складе ядра');
	} catch (err) {
		log.warn({ repairNo: data.repairNo }, `[repairs] склад ядра: позицию завести/переименовать не вышло — ${errInfo(err)}`);
		if (opts.allowCreate) throw err;
	}
}

/** Движение позиции по смене статуса (этап 2). Ошибка блокирует смену статуса; мутирует data.repairStore.
 *  Только вперёд: откат статуса остаток не двигает (ограничение v1). Карта:
 *   принято в офисе → Измайловский · отправлено в ремонт → транзит · отправлено на ТТ → транзит
 *   готово к выдаче → склад выдачи · выдано → склад не трогаем (дальше работа в сделке). */
export async function moveRepairForStatus(data: RepairData, newStatus: RepairStatus, log: FastifyInstance['log']): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('ядро склада недоступно — статус ремонта не изменён');
	if (!data.repairItemCode) {
		const recoveredItemCode = `REPAIR-${data.repairNo}`;
		const recoveredLocation = await locateRepairUnit(erp, recoveredItemCode);
		if (!recoveredLocation) {
			throw new Error(`у ремонта №${data.repairNo} нет складской карточки — сначала восстановите учёт аппарата в ядре`);
		}
		data.repairItemCode = recoveredItemCode;
		data.repairStore = recoveredLocation.storeTitle;
		log.info(
			{ repairNo: data.repairNo, itemCode: recoveredItemCode, store: recoveredLocation.storeTitle },
			'[repairs] восстановлена связь ремонта со складской карточкой',
		);
	}
	const target = newStatus === 'received_office' ? OFFICE_STORE
		: newStatus === 'sent' ? TRANSIT_STORE
		: newStatus === 'sent_to_tt' ? TRANSIT_STORE
		: newStatus === 'ready_tt' ? (data.issueStore?.trim() || null)
		: null;
	if (!target) {
		if (newStatus === 'ready_tt') throw new Error('для статуса «Готово к выдаче» сначала выберите склад выдачи');
		const actual = await locateRepairUnit(erp, data.repairItemCode);
		if (!actual) throw new Error(`ремонтная позиция ${data.repairItemCode} отсутствует на складах ядра`);
		data.repairStore = actual.storeTitle;
		return;
	}
	const actual = await locateRepairUnit(erp, data.repairItemCode);
	if (!actual) throw new Error(`ремонтная позиция ${data.repairItemCode} отсутствует на складах ядра`);
	const from = actual.storeTitle;
	data.repairStore = from;
	if (from === target) { data.repairStore = target; return; } // уже там (напр. приняли сразу в офисе)
	await moveRepairUnit(erp, { itemCode: data.repairItemCode, fromStore: from, toStore: target });
	data.repairStore = target;
	log.info({ itemCode: data.repairItemCode, from, to: target }, '[repairs] позиция перемещена по статусу');
}

/** Списание аппарата при «Выдано» (клиентский): Delivery Note в ядре, цена 0 (выдаём владельцу, не продаём),
 *  привязка к сделке. Идемпотентно; ошибка блокирует смену статуса. */
export async function writeOffRepairOnIssue(data: RepairData, log: FastifyInstance['log']): Promise<void> {
	const erp = ErpClient.fromEnv();
	if (!data.repairItemCode) {
		throw new Error(`у ремонта №${data.repairNo} нет складской карточки — выдача без списания аппарата запрещена`);
	}
	if (!erp) throw new Error('ядро склада недоступно — выдача ремонта не проведена');
	if (data.repairDeliveryNote) {
		const existing = await erp.get<Record<string, unknown>>('Delivery Note', data.repairDeliveryNote);
		if (Number(existing?.['docstatus'] ?? 0) === 1) {
			data.repairStore = null;
			return;
		}
		data.repairDeliveryNote = null;
	}
	const actual = await locateRepairUnit(erp, data.repairItemCode);
	if (!actual) throw new Error(`ремонтная позиция ${data.repairItemCode} отсутствует на складах ядра`);
	const dn = await deliverRepairUnit(erp, {
		itemCode: data.repairItemCode,
		storeTitle: actual.storeTitle,
		...(data.dealId ? { dealId: data.dealId } : {}),
	});
	data.repairDeliveryNote = dn.name;
	data.repairStore = null; // аппарат выдан — со склада списан
	log.info({ itemCode: data.repairItemCode, dn: dn.name }, '[repairs] аппарат списан при выдаче (Delivery Note)');
}

/** ПРЕДПРОДАЖНЫЙ: движение существующего товара (productId) по статусам. Best-effort; мутирует repairStore.
 *  Карта: принято в офисе→Измайловский · отправлено в ремонт→транзит · принято с ремонта в офис→Измайловский ·
 *  отправлено на точку→транзит (нужен склад точки = issueStore) · принято на ТТ→склад точки (issueStore). */
export async function movePresaleForStatus(data: RepairData, newStatus: RepairStatus, log: FastifyInstance['log']): Promise<void> {
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
