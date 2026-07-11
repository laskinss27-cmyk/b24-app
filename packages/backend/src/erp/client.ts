/**
 * ERPNext REST-клиент (headless-ядро склада, архитектура «покрывало»).
 *
 * Конфиг из env: ERPNEXT_URL, ERPNEXT_TOKEN ("token key:secret"), опц. ERP_COMPANY.
 * Грабли, учтённые здесь (см. docs/sklad-vynos.md):
 *  - проведение = PUT {docstatus:1} + ПРОВЕРКА docstatus в ответе (frappe.client.submit
 *    с частичным doc отвечает 200, не проведя);
 *  - в инсталляции может быть демо-компания и она дефолтная → company во все документы ЯВНО;
 *  - ошибки ERPNext прячутся в _server_messages (JSON-в-JSON) — разворачиваем.
 */

export interface ErpConfig {
	url: string;
	token: string; // формат "token <key>:<secret>"
}

export class ErpApiError extends Error {
	constructor(
		public readonly method: string,
		public readonly path: string,
		public readonly status: number,
		message: string,
	) {
		super(`ERPNext [${method} ${path}] ${status}: ${message}`);
		this.name = 'ErpApiError';
	}
}

function extractError(status: number, json: Record<string, unknown>): string {
	let msg = String(json['exception'] ?? json['message'] ?? '');
	const sm = json['_server_messages'];
	if (typeof sm === 'string' && sm) {
		try {
			msg = (JSON.parse(sm) as string[])
				.map((s) => {
					try { return String((JSON.parse(s) as { message?: string }).message ?? s); }
					catch { return s; }
				})
				.join('; ');
		} catch { /* оставляем exception */ }
	}
	return msg.slice(0, 400) || `HTTP ${status}`;
}

export class ErpClient {
	constructor(private readonly cfg: ErpConfig) {}

	static fromEnv(): ErpClient | null {
		const url = process.env['ERPNEXT_URL'];
		const token = process.env['ERPNEXT_TOKEN'];
		if (!url || !token) return null;
		return new ErpClient({ url: url.replace(/\/$/, ''), token });
	}

	async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
		// Таймаут: ядро за мостом (VPS→ноутбук) может быть недостижимо — без таймаута fetch висит
		// до 60с-лимита контейнера. 25с < лимита: падаем с ошибкой, а не залипаем (выстрадано 2026-06-15).
		const res = await fetch(`${this.cfg.url}${path}`, {
			method,
			headers: { Authorization: this.cfg.token, 'Content-Type': 'application/json' },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(25000),
		});
		const text = await res.text();
		let json: Record<string, unknown>;
		try { json = JSON.parse(text) as Record<string, unknown>; }
		catch { json = { raw: text.slice(0, 300) }; }
		if (res.status >= 300) throw new ErpApiError(method, path, res.status, extractError(res.status, json));
		return { status: res.status, json };
	}

	/** Список документов. fields/filters — как в Frappe REST. Без лимита (limit_page_length=0). */
	async list<T = Record<string, unknown>>(doctype: string, fields: string[], filters?: unknown[], limit = 0, orderBy?: string): Promise<T[]> {
		const q = new URLSearchParams({ fields: JSON.stringify(fields), limit_page_length: String(limit) });
		if (filters) q.set('filters', JSON.stringify(filters));
		if (orderBy) q.set('order_by', orderBy);
		const r = await this.request('GET', `/api/resource/${encodeURIComponent(doctype)}?${q}`);
		return (r.json['data'] as T[]) ?? [];
	}

	/** Полный документ (с дочерними таблицами). null — не существует. */
	async get<T = Record<string, unknown>>(doctype: string, name: string): Promise<T | null> {
		try {
			const r = await this.request('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
			return (r.json['data'] as T) ?? null;
		} catch (e) {
			if (e instanceof ErpApiError && e.status === 404) return null;
			throw e;
		}
	}

	async create(doctype: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
		const r = await this.request('POST', `/api/resource/${encodeURIComponent(doctype)}`, fields);
		return (r.json['data'] as Record<string, unknown>) ?? {};
	}

	async update(doctype: string, name: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
		const r = await this.request('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, fields);
		return (r.json['data'] as Record<string, unknown>) ?? {};
	}

	async delete(doctype: string, name: string): Promise<void> {
		await this.request('DELETE', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
	}

	/** Проведение документа. Бросает, если docstatus в ответе не стал 1. */
	async submit(doctype: string, name: string): Promise<void> {
		const data = await this.update(doctype, name, { docstatus: 1 });
		if (Number(data['docstatus'] ?? 0) !== 1) {
			throw new ErpApiError('PUT', `${doctype}/${name}`, 200, `submit прошёл без ошибки, но docstatus=${data['docstatus']}`);
		}
	}

	/** Отмена проведённого (docstatus 1 → 2). */
	async cancel(doctype: string, name: string): Promise<void> {
		const data = await this.update(doctype, name, { docstatus: 2 });
		if (Number(data['docstatus'] ?? 0) !== 2) {
			throw new ErpApiError('PUT', `${doctype}/${name}`, 200, `cancel прошёл без ошибки, но docstatus=${data['docstatus']}`);
		}
	}
}
