import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

/** Разложить «Иванов Иван Иваныч» на поля контакта Б24. ≥2 слов → Фамилия/Имя/Отчество; 1 слово → Имя. */
function splitFio(fio: string): { LAST_NAME: string; NAME: string; SECOND_NAME: string } {
	const parts = fio.trim().split(/\s+/).filter(Boolean);
	if (parts.length >= 2) return { LAST_NAME: parts[0]!, NAME: parts[1]!, SECOND_NAME: parts.slice(2).join(' ') };
	return { LAST_NAME: '', NAME: parts[0] ?? '', SECOND_NAME: '' };
}

/** Клиент ремонта = контакт Б24. Уже привязан → берём; иначе ищем по телефону (Б24 не даст дубль с тем же
 *  номером) и при отсутствии заводим новый контакт с телефоном. Возвращает id (null — не вышло/нет данных). */
export async function resolveOrCreateContact(
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
