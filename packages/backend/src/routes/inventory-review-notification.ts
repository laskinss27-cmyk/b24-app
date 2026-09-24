import { APP_OWNER_USER_ID } from '@b24-app/shared';
import { B24Client } from '../b24/client.js';

export function inventoryReviewMessage(args: {
	inventoryId: string;
	storeName: string;
	managerName: string;
	result: Record<string, unknown> | null;
	appUrl?: string;
}): string {
	const counted = Number(args.result?.['counted'] ?? 0);
	const total = Number(args.result?.['total'] ?? 0);
	const discrepancies = Number(args.result?.['discrepancies'] ?? 0);
	const unfilled = Number(args.result?.['unfilled'] ?? 0);
	return [
		'[B]Инвентаризация отправлена на проверку[/B]',
		`Инвентаризация #${args.inventoryId} · ${args.storeName}`,
		`Менеджер: ${args.managerName || 'не указан'}`,
		`Посчитано: ${counted} из ${total}`,
		`Расхождений: ${discrepancies}`,
		...(unfilled > 0 ? [`Не заполнено: ${unfilled} (рассчитано как 0)`] : []),
		...(args.appUrl ? ['', args.appUrl] : []),
	].join('\n');
}

export async function sendInventoryReviewNotification(args: {
	webhook: string;
	inventoryId: string;
	storeName: string;
	managerName: string;
	result: Record<string, unknown> | null;
	appUrl?: string;
}): Promise<void> {
	const client = new B24Client({ auth: { kind: 'webhook', url: args.webhook } });
	await client.call('im.message.add', {
		DIALOG_ID: APP_OWNER_USER_ID,
		MESSAGE: inventoryReviewMessage(args),
		SYSTEM: 'N',
		URL_PREVIEW: 'Y',
	});
}
