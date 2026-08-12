import { normalizeStatus, type RepairKind, type RepairStatus } from './repair-status.js';

export interface RepairPhoto { id: number; name: string; url: string }
/** Прикреплённый документ (Word/Excel/PDF) — хранится на Диске Б24, в карточке только ссылка. */
export interface RepairFile { id: number; name: string; url: string; type: string }

export interface RepairClientRefusal {
	at: string;
	reason: string;
	byId: string;
	byName: string;
	dealCancelled: boolean;
	taskReframed: boolean;
}

export interface RepairData {
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
	/** Клиент отказался ждать ремонт. Физический статус аппарата при этом не меняется. */
	clientRefusal: RepairClientRefusal | null;
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
export function parseItem(it: Record<string, unknown>): (RepairData & { id: number; name: string }) | null {
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
		clientRefusal: data.clientRefusal && typeof data.clientRefusal.reason === 'string'
			? {
				at: String(data.clientRefusal.at ?? ''),
				reason: data.clientRefusal.reason,
				byId: String(data.clientRefusal.byId ?? ''),
				byName: String(data.clientRefusal.byName ?? ''),
				dealCancelled: Boolean(data.clientRefusal.dealCancelled),
				taskReframed: Boolean(data.clientRefusal.taskReframed),
			}
			: null,
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
