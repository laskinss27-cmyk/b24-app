import type { B24Client } from './b24/client.js';

interface RepairDeepLinkOptions {
	portalDomain: string;
	appClientId?: string | undefined;
	configuredBase?: string | undefined;
	repairId: number;
	repairNo: number;
}

export function buildRepairDeepLink(options: RepairDeepLinkOptions): string {
	const configuredBase = String(options.configuredBase ?? '').trim();
	const appCode = String(options.appClientId ?? '').trim();
	const base = configuredBase
		|| (appCode
			? `https://${options.portalDomain}/marketplace/view/${encodeURIComponent(appCode)}/`
			: `https://${options.portalDomain}/devops/placement/568/`);
	const url = new URL(base);
	url.searchParams.set(base.includes('/marketplace/view/') ? 'params[repairId]' : 'repairId', String(options.repairId));
	return `[URL=${url.toString()}]Открыть ремонт #${options.repairNo || options.repairId}[/URL]`;
}

export async function addRepairLinkToDealTimeline(
	client: B24Client,
	dealId: number,
	comment: string,
): Promise<void> {
	await client.call('crm.timeline.comment.add', {
		fields: {
			ENTITY_ID: dealId,
			ENTITY_TYPE: 'deal',
			COMMENT: comment,
		},
	});
}
