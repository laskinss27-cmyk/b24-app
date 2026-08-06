import { call } from './bitrix-client.js';

/** Инициаторы по умолчанию: Дранишников (1), Бекасов (986). Дальше ведут сами через app.option. */
const DEFAULT_INITIATORS = ['1', '986'];

export async function getInitiators(): Promise<string[]> {
	try {
		const opts = await call<Record<string, unknown>>('app.option.get', {});
		const raw = opts?.['inv_initiators'];
		if (typeof raw === 'string' && raw) {
			const arr = JSON.parse(raw) as unknown;
			if (Array.isArray(arr) && arr.length) return arr.map(String);
		}
	} catch {
		/* настройки нет — дефолт */
	}
	return DEFAULT_INITIATORS;
}
export async function setInitiators(ids: string[]): Promise<void> {
	await call('app.option.set', { options: { inv_initiators: JSON.stringify([...new Set(ids)]) } });
}
