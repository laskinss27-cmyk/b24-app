import { bx24Auth } from './bitrix-auth.js';

export type RepairKind = 'client' | 'presale';
export type RepairStatus =
	| 'received_tt' | 'received_office' | 'sent' | 'sent_to_tt' | 'ready_tt' | 'issued'   // клиентский
	| 'pre_office' | 'pre_sent' | 'pre_back_office' | 'pre_to_point' | 'pre_at_tt';        // предпродажный
export interface RepairPhoto { id: number; name: string; url: string }
/** Прикреплённый документ (Word/Excel/PDF) — лежит на Диске Б24, в карточке ссылка. */
export interface RepairFile { id: number; name: string; url: string; type: string }
export interface Repair {
	id: number;
	name: string;
	/** Поток: 'client' (клиентский RMA) | 'presale' (предпродажный — наш товар со склада). По умолчанию client. */
	kind?: RepairKind;
	status: RepairStatus;
	/** Свой номер ремонта (со 100), независимый от технического ID хранилища. */
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
	/** Цена ремонта СЦ — что берёт сервисный центр (только у платных; у гарантийных null). */
	cost: number | null;
	/** Наша цена — что берём с клиента (только у платных; основа суммы сделки). */
	ourPrice: number | null;
	/** ID созданной по ремонту сделки Б24 (null — ещё не создана). */
	dealId: number | null;
	/** ID задачи Б24 для снабжения/автора по этому ремонту. */
	taskId?: number | null;
	/** Временная подсказка после создания, если Б24 не дал создать задачу. В хранилище ремонта не пишется. */
	taskWarning?: string;
	/** Временное предупреждение о частичной синхронизации сделки. В хранилище ремонта не пишется. */
	dealSyncWarning?: string;
	/** Код позиции ремонтного аппарата на складе ядра (`REPAIR-<номер>`; null — ещё не заведена). */
	repairItemCode?: string | null;
	/** Где аппарат лежит сейчас (название склада Б24). */
	repairStore?: string | null;
	/** Склад выдачи (клиентский) / склад точки (предпродажный) — финальная точка перемещения. */
	issueStore?: string | null;
	/** ПРЕДПРОДАЖНЫЙ: productId товара, отправленного в ремонт. */
	productId?: number | null;
	/** ПРЕДПРОДАЖНЫЙ: склад-источник, откуда товар ушёл в ремонт. */
	sourceStore?: string | null;
	/** Комментарий сервисного центра (диагностика/итог) — заполняется после возврата. */
	comment: string;
	/** Внутренний комментарий по ремонту: виден в карточке и списке, в печатный акт не попадает. */
	internalComment?: string;
	photos: RepairPhoto[];
	files: RepairFile[];
	createdAt: string;
	createdById: string;
	createdByName: string;
	/** Лог: смена статуса (note пуст) либо изменение вида/цены (note описывает). byName — кто. */
	history: Array<{ at: string; status: RepairStatus; byId: string; byName?: string; note?: string }>;
}
export interface RepairContact { id: number; name: string; phone: string }
export interface RepairDealSyncResult {
	dealCreated: boolean;
	dealNoContact: boolean;
	syncWarning: string | null;
}
export interface NewRepairInput {
	client: { contactId: number | null; name: string; phone: string };
	device: string;
	model: string;
	serial: string;
	point: string;
	appearance: string;
	defect: string;
	payType: 'warranty' | 'paid';
	cost: number | null;
	ourPrice: number | null;
	comment: string;
	internalComment: string;
	photos: RepairPhoto[];
	files: RepairFile[];
}

export async function fetchRepairs(): Promise<{ repairs: Repair[]; canEditPrice: boolean }> {
	const res = await fetch('/api/repairs/list', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repairs?: Repair[]; canEditPrice?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить список ремонтов');
	return { repairs: json.repairs ?? [], canEditPrice: Boolean(json.canEditPrice) };
}

export async function createRepair(input: NewRepairInput): Promise<Repair> {
	const res = await fetch('/api/repairs/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; syncWarning?: string | null; taskCreated?: boolean; taskError?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось принять в ремонт');
	if ('taskCreated' in json && !json.taskCreated) json.repair.taskWarning = `Задача не создана: ${json.taskError || 'Б24 не вернул ID задачи'}`;
	if (json.syncWarning) json.repair.dealSyncWarning = json.syncWarning;
	return json.repair;
}

/** Открыть нативную карточку задачи Б24. */
export function openTask(taskId: number): void {
	const path = `/company/personal/user/0/tasks/task/view/${taskId}/`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const auth = bx ? bx.getAuth() : false;
		window.open(`https://${auth ? (auth.domain ?? '') : ''}${path}`, '_blank');
	}
}

/** Остатки склада из ядра — пикер аппарата для предпродажного ремонта. */
export async function fetchRepairStoreStock(store: string): Promise<Array<{ productId: number; name: string; qty: number }>> {
	const res = await fetch('/api/repairs/store-stock', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), store }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; items?: Array<{ productId: number; name: string; qty: number }> };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить остатки склада');
	return json.items ?? [];
}

/** Принять в ПРЕДПРОДАЖНЫЙ ремонт: товар со склада-источника (productId) уходит чиниться. */
export async function createPresaleRepair(sourceStore: string, productId: number, itemName: string): Promise<Repair> {
	const res = await fetch('/api/repairs/create-presale', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), sourceStore, productId, itemName }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; taskCreated?: boolean; taskError?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось создать предпродажный ремонт');
	if ('taskCreated' in json && !json.taskCreated) json.repair.taskWarning = `Задача не создана: ${json.taskError || 'Б24 не вернул ID задачи'}`;
	return json.repair;
}

export async function updateRepair(id: number, input: NewRepairInput): Promise<Repair> {
	const res = await fetch('/api/repairs/update', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; syncWarning?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось сохранить ремонт');
	if (json.syncWarning) json.repair.dealSyncWarning = json.syncWarning;
	return json.repair;
}

export async function updateRepairInternalComment(id: number, internalComment: string): Promise<Repair> {
	const res = await fetch('/api/repairs/update-internal-comment', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, internalComment }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось сохранить комментарий');
	return json.repair;
}

export async function deleteRepair(id: number): Promise<void> {
	const res = await fetch('/api/repairs/delete', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить ремонт');
}

export async function updateRepairStatus(id: number, status: RepairStatus): Promise<RepairDealSyncResult> {
	const res = await fetch('/api/repairs/update-status', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, status }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; dealCreated?: boolean; dealNoContact?: boolean; syncWarning?: string | null };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сменить статус');
	return {
		dealCreated: Boolean(json.dealCreated),
		dealNoContact: Boolean(json.dealNoContact),
		syncWarning: json.syncWarning ?? null,
	};
}

export async function searchRepairContacts(q: string): Promise<RepairContact[]> {
	if (q.trim().length < 2) return [];
	const res = await fetch('/api/repairs/search-contacts', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), q }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; contacts?: RepairContact[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось найти контакты');
	return json.contacts ?? [];
}

/** Найти контакт по телефону (контроль дублей при приёмке). null — номер свободен. */
export async function findRepairContactByPhone(phone: string): Promise<RepairContact | null> {
	if (phone.trim().length < 4) return null;
	const res = await fetch('/api/repairs/find-by-phone', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), phone }),
	});
	const json = (await res.json()) as { ok: boolean; contact?: RepairContact | null };
	return json.ok ? (json.contact ?? null) : null;
}

/** Загрузить фото на Б24 Диск. Best-effort: вернёт null, если Диск недоступен. */
export async function uploadRepairPhoto(file: File): Promise<RepairPhoto | null> {
	const content = await new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result ?? '').replace(/^data:[^,]*,/, ''));
		r.onerror = () => reject(new Error('не прочитать файл'));
		r.readAsDataURL(file);
	});
	const res = await fetch('/api/repairs/upload-photo', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), fileName: file.name, content }),
	});
	const json = (await res.json()) as { ok: boolean; photo?: RepairPhoto };
	return json.ok && json.photo ? json.photo : null;
}

/** Загрузить документ (Word/Excel/PDF) на Б24 Диск. Best-effort: null если Диск недоступен. */
export async function uploadRepairFile(file: File): Promise<RepairFile | null> {
	const content = await new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result ?? '').replace(/^data:[^,]*,/, ''));
		r.onerror = () => reject(new Error('не прочитать файл'));
		r.readAsDataURL(file);
	});
	const res = await fetch('/api/repairs/upload-photo', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), fileName: file.name, content }),
	});
	const json = (await res.json()) as { ok: boolean; photo?: RepairPhoto };
	if (!json.ok || !json.photo) return null;
	return { ...json.photo, type: file.type || '' };
}

export async function getRepairFileUrl(id: number): Promise<string> {
	const res = await fetch('/api/repairs/file-link', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; url?: string };
	if (!json.ok || !json.url) throw new Error(json.error ?? 'не удалось получить ссылку на файл');
	return json.url;
}

/** Быстрая смена вида ремонта платный↔гарантийный (+ цена СЦ и наша цена при платном).
 * При простановке «нашей цены» сервер сам заводит/обновляет сделку → возвращает dealId/флаги. */
/** Задать склад выдачи (на странице просмотра). При «Готово к выдаче» сервер перемещает аппарат на него. */
export async function setRepairIssueStore(id: number, issueStore: string): Promise<string | null> {
	const res = await fetch('/api/repairs/set-issue-store', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, issueStore }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; issueStore?: string | null };
	if (!json.ok) throw new Error(json.error ?? 'не удалось задать склад выдачи');
	return json.issueStore ?? null;
}

export async function setRepairPayType(id: number, payType: 'warranty' | 'paid', cost: number | null, ourPrice: number | null): Promise<{ payType: 'warranty' | 'paid'; cost: number | null; ourPrice: number | null; dealId: number | null } & RepairDealSyncResult> {
	const res = await fetch('/api/repairs/set-pay', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, payType, cost, ourPrice }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; payType?: 'warranty' | 'paid'; cost?: number | null; ourPrice?: number | null; dealId?: number | null; dealCreated?: boolean; dealNoContact?: boolean; syncWarning?: string | null };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сменить вид ремонта');
	return { payType: json.payType ?? payType, cost: json.cost ?? null, ourPrice: json.ourPrice ?? null, dealId: json.dealId ?? null, dealCreated: Boolean(json.dealCreated), dealNoContact: Boolean(json.dealNoContact), syncWarning: json.syncWarning ?? null };
}

export async function requestRepairPriceApproval(id: number, cost: number | null, ourPrice: number | null): Promise<{ repair: Repair } & RepairDealSyncResult> {
	const res = await fetch('/api/repairs/request-price-approval', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, cost, ourPrice }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; dealCreated?: boolean; dealNoContact?: boolean; syncWarning?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось отправить цену на согласование');
	return { repair: json.repair, dealCreated: Boolean(json.dealCreated), dealNoContact: Boolean(json.dealNoContact), syncWarning: json.syncWarning ?? null };
}

export async function syncRepairDealNow(id: number): Promise<{ repair: Repair } & RepairDealSyncResult> {
	const res = await fetch('/api/repairs/sync-deal', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; dealCreated?: boolean; dealNoContact?: boolean; syncWarning?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось синхронизировать сделку');
	return {
		repair: json.repair,
		dealCreated: Boolean(json.dealCreated),
		dealNoContact: Boolean(json.dealNoContact),
		syncWarning: json.syncWarning ?? null,
	};
}
