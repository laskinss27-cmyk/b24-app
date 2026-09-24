import { B24Client } from '../b24/client.js';

const STORE_CHATS = new Map<string, string>([
	// В новой группе «Админка по ТТ» для секции 23 нет отдельного чата.
	['железноводская, секция 23', 'chat4150'],
	['железноводская, секция 34', 'chat17424'],
	['максидом богатырский 15', 'chat17416'],
	['максидом дунайский 64', 'chat17422'],
	['максидом московский 131', 'chat17420'],
	['максидом тельмана 31', 'chat17414'],
	['максидом ул. фаворского 12', 'chat17412'],
]);

/** Native Bitrix catalog store ids for point reservations. Names can be edited, ids stay stable. */
const STORE_ID_CHATS = new Map<number, string>([
	[8, 'chat17422'],
	[10, 'chat17416'],
	[12, 'chat17414'],
	[14, 'chat17420'],
	[16, 'chat17424'],
	[20, 'chat4150'],
	[22, 'chat17412'],
]);

export function storeChat(store: string): string | null {
	const normalized = store.toLowerCase().replace(/\s+-\s+уд$/u, '').trim();
	return STORE_CHATS.get(normalized) ?? null;
}

export function reservationStoreChat(storeId: number, store: string): string | null {
	return STORE_ID_CHATS.get(storeId) ?? storeChat(store);
}

/** Чат, в котором сопровождаем прибытие: точка назначения, либо точка отправки для маршрута в центральный склад. */
export function receivingChatStore(fromStore: string, toStore: string): string | null {
	if (storeChat(toStore)) return toStore;
	if (storeChat(fromStore)) return fromStore;
	return null;
}

export async function sendStoreChatMessage(client: B24Client, store: string, message: string): Promise<boolean> {
	const dialogId = storeChat(store);
	if (!dialogId) return false;
	await client.call('im.message.add', {
		DIALOG_ID: dialogId,
		MESSAGE: message,
		SYSTEM: 'N',
		URL_PREVIEW: 'Y',
	});
	return true;
}

export async function sendReservationStoreChatMessage(client: B24Client, storeId: number, store: string, message: string): Promise<boolean> {
	const dialogId = reservationStoreChat(storeId, store);
	if (!dialogId) return false;
	await client.call('im.message.add', {
		DIALOG_ID: dialogId,
		MESSAGE: message,
		SYSTEM: 'N',
		URL_PREVIEW: 'Y',
	});
	return true;
}
