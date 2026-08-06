import { bx24Auth } from './bitrix-auth.js';

export interface KpRow {
	productId: number;
	name: string;
	article: string;
	qty: number;
	price: number;
	sum: number;
	isWork: boolean;
	/** Устаревшее служебное поле: печатные формы этапы не показывают. */
	stage?: string;
	/** Путь или URL изображения из товарной базы Б24. */
	photoPath?: string;
}
export interface KpData {
	number: number;
	date: string;
	title: string;
	client: { name: string; phone: string };
	manager: { name: string; phone: string };
	goods: KpRow[];
	works: KpRow[];
	sumGoods: number;
	sumWorks: number;
	total: number;
}

export async function fetchDealKp(dealId: number, variantId?: string): Promise<KpData> {
	const res = await fetch('/api/deal/kp', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, ...(variantId ? { variantId } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; kp?: KpData };
	if (!json.ok || !json.kp) throw new Error(json.error ?? 'не удалось собрать КП');
	return json.kp;
}

/** Скачать редактируемую Word-версию КП. */
export async function downloadDealKpDocx(dealId: number, variantId?: string): Promise<void> {
	const kp = await fetchDealKp(dealId, variantId);
	const res = await fetch('/api/deal/kp-docx', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, kp }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
		let message = `не удалось сформировать Word (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `kp-${dealId}.docx`;
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Скачать клиентскую Excel-версию КП. */
export async function downloadDealXlsx(dealId: number, variantId?: string): Promise<void> {
	const kp = await fetchDealKp(dealId, variantId);
	const res = await fetch('/api/deal/kp-xlsx', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, kp }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
		let message = `не удалось сформировать Excel (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `kp-${dealId}.xlsx`;
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}
