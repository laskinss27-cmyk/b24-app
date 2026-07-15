import { B24Client } from '../b24/client.js';

const STORE_CHATS = new Map<string, string>([
	['железноводская, секция 23', 'chat4138'],
	['железноводская, секция 34', 'chat4140'],
	['максидом богатырский 15', 'chat4144'],
	['максидом дунайский 64', 'chat4146'],
	['максидом московский 131', 'chat4150'],
	['максидом тельмана 31', 'chat4152'],
	['максидом ул. фаворского 12', 'chat4154'],
]);

export function storeChat(store: string): string | null {
	const normalized = store.toLowerCase().replace(/\s+-\s+уд$/u, '').trim();
	return STORE_CHATS.get(normalized) ?? null;
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
