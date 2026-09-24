/**
 * Read-only capability probe for analytics data exposed by the current Bitrix24 webhook.
 * Prints only counts, field availability, and fill rates; no deal titles or personal data.
 */
import 'dotenv/config';
import { B24ApiError, B24Client } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) throw new Error('DEV_WEBHOOK is not configured');

// The current cloud limit for non-Enterprise portals is 2 sustained HTTP requests/sec.
const client = new B24Client({ auth: { kind: 'webhook', url: webhook }, requestsPerSecond: 1 });

type Row = Record<string, unknown>;

function rowsFrom(value: unknown): Row[] {
	if (Array.isArray(value)) return value.filter((row): row is Row => typeof row === 'object' && row !== null);
	if (typeof value === 'object' && value !== null) {
		const items = (value as { items?: unknown }).items;
		if (Array.isArray(items)) return items.filter((row): row is Row => typeof row === 'object' && row !== null);
	}
	return [];
}

function present(value: unknown): boolean {
	return value !== null && value !== undefined && value !== '';
}

function coverage(rows: Row[], fields: string[]): Record<string, string> {
	return Object.fromEntries(fields.map((field) => {
		const count = rows.filter((row) => present(row[field])).length;
		return [field, `${count}/${rows.length}`];
	}));
}

function counts(rows: Row[], field: string): Record<string, number> {
	const values = new Map<string, number>();
	for (const row of rows) {
		const value = present(row[field]) ? String(row[field]) : '(empty)';
		values.set(value, (values.get(value) ?? 0) + 1);
	}
	return Object.fromEntries([...values.entries()].sort((left, right) => right[1] - left[1]));
}

function errorInfo(error: unknown): string {
	if (error instanceof B24ApiError) return `${error.code}: ${error.description ?? ''}`;
	return error instanceof Error ? error.message : String(error);
}

async function incrementalProbe(
	method: string,
	params: Record<string, unknown>,
): Promise<{ available: true; pageRows: number; totalVisible: number | null } | { available: false; error: string }> {
	try {
		const meta = await client.callWithMeta<unknown>(method, params);
		return { available: true, pageRows: rowsFrom(meta.result).length, totalVisible: meta.total ?? null };
	} catch (error) {
		return { available: false, error: errorInfo(error) };
	}
}

async function main(): Promise<void> {
	const report: Record<string, unknown> = {};

	const dealFields = await client.call<Record<string, unknown>>('crm.deal.fields');
	const requiredDealFields = [
		'ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'ASSIGNED_BY_ID',
		'DATE_CREATE', 'DATE_MODIFY', 'MOVED_TIME', 'LAST_ACTIVITY_TIME', 'LAST_ACTIVITY_BY',
		'SOURCE_ID', 'TYPE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'CLOSEDATE',
	];
	report.dealSchema = {
		available: Object.fromEntries(requiredDealFields.map((field) => [field, field in dealFields])),
		customFieldCount: Object.keys(dealFields).filter((field) => field.startsWith('UF_CRM_')).length,
	};

	const dealsMeta = await client.callWithMeta<unknown>('crm.deal.list', {
		order: { ID: 'DESC' },
		filter: { STAGE_SEMANTIC_ID: 'P' },
		select: requiredDealFields,
		start: 0,
	});
	const deals = rowsFrom(dealsMeta.result);
	const allDealsMeta = await client.callWithMeta<unknown>('crm.deal.list', {
		order: { ID: 'ASC' },
		select: ['ID'],
		start: 0,
	});
	report.openDeals = {
		pageRows: deals.length,
		totalVisible: dealsMeta.total ?? null,
		allDealsVisible: allDealsMeta.total ?? null,
		coverage: coverage(deals, requiredDealFields.filter((field) => field !== 'TITLE')),
		categoriesOnPage: counts(deals, 'CATEGORY_ID'),
		stagesOnPage: counts(deals, 'STAGE_ID'),
	};

	try {
		const historyMeta = await client.callWithMeta<unknown>('crm.stagehistory.list', {
			entityTypeId: 2,
			order: { ID: 'DESC' },
			select: ['ID', 'TYPE_ID', 'OWNER_ID', 'CREATED_TIME', 'CATEGORY_ID', 'STAGE_SEMANTIC_ID', 'STAGE_ID'],
			start: 0,
		});
		const history = rowsFrom(historyMeta.result);
		report.stageHistory = {
			available: true,
			pageRows: history.length,
			totalVisible: historyMeta.total ?? null,
			coverage: coverage(history, ['TYPE_ID', 'OWNER_ID', 'CREATED_TIME', 'CATEGORY_ID', 'STAGE_SEMANTIC_ID', 'STAGE_ID']),
			eventTypesOnPage: counts(history, 'TYPE_ID'),
		};
	} catch (error) {
		report.stageHistory = { available: false, error: errorInfo(error) };
	}

	try {
		const activityMeta = await client.callWithMeta<unknown>('crm.activity.list', {
			order: { ID: 'DESC' },
			filter: { OWNER_TYPE_ID: 2 },
			select: [
				'ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID',
				'CREATED', 'LAST_UPDATED', 'START_TIME', 'END_TIME', 'DEADLINE', 'COMPLETED',
				'STATUS', 'RESPONSIBLE_ID', 'DIRECTION', 'AUTHOR_ID', 'EDITOR_ID', 'BINDINGS',
			],
			start: 0,
		});
		const activities = rowsFrom(activityMeta.result);
			report.activities = {
			available: true,
			pageRows: activities.length,
			totalVisible: activityMeta.total ?? null,
			coverage: coverage(activities, [
				'OWNER_ID', 'TYPE_ID', 'CREATED', 'LAST_UPDATED', 'START_TIME', 'END_TIME',
				'DEADLINE', 'COMPLETED', 'RESPONSIBLE_ID', 'DIRECTION', 'BINDINGS',
			]),
			typesOnPage: counts(activities, 'TYPE_ID'),
			completionOnPage: counts(activities, 'COMPLETED'),
			providerIdsOnPage: counts(activities, 'PROVIDER_ID'),
			providerTypesOnPage: counts(activities, 'PROVIDER_TYPE_ID'),
		};

		const typeTotals: Record<string, number | null> = {};
		for (const typeId of [1, 2, 3, 4, 5, 6]) {
			const meta = await client.callWithMeta<unknown>('crm.activity.list', {
				filter: { OWNER_TYPE_ID: 2, TYPE_ID: typeId },
				select: ['ID'],
				start: 0,
			});
			typeTotals[String(typeId)] = meta.total ?? null;
		}
		const now = new Date().toISOString();
		const [openMeta, overdueMeta, futureMeta] = await Promise.all([
			client.callWithMeta<unknown>('crm.activity.list', {
				filter: { OWNER_TYPE_ID: 2, COMPLETED: 'N' }, select: ['ID'], start: 0,
			}),
			client.callWithMeta<unknown>('crm.activity.list', {
				filter: { OWNER_TYPE_ID: 2, COMPLETED: 'N', '<DEADLINE': now }, select: ['ID'], start: 0,
			}),
			client.callWithMeta<unknown>('crm.activity.list', {
				filter: { OWNER_TYPE_ID: 2, COMPLETED: 'N', '>=DEADLINE': now }, select: ['ID'], start: 0,
			}),
		]);
		(report.activities as Record<string, unknown>).totalsByType = typeTotals;
		(report.activities as Record<string, unknown>).openVisible = openMeta.total ?? null;
		(report.activities as Record<string, unknown>).overdueVisible = overdueMeta.total ?? null;
		(report.activities as Record<string, unknown>).futureVisible = futureMeta.total ?? null;
	} catch (error) {
		report.activities = { available: false, error: errorInfo(error) };
	}

	const [categories, sources, usersMeta] = await Promise.all([
		client.call<{ categories?: unknown[] }>('crm.category.list', { entityTypeId: 2 }),
		client.call<unknown>('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' }, order: { SORT: 'ASC' } }),
		client.callWithMeta<unknown>('user.get', { FILTER: { ACTIVE: true }, start: 0 }),
	]);
	report.dictionaries = {
		dealCategories: Array.isArray(categories.categories) ? categories.categories.length : 0,
		sources: rowsFrom(sources).length,
		activeUsersFirstPage: rowsFrom(usersMeta.result).length,
		activeUsersTotalVisible: usersMeta.total ?? null,
	};

	const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
	report.incrementalFilters = {
		dealsByDateModify: await incrementalProbe('crm.deal.list', {
			filter: { '>=DATE_MODIFY': since }, select: ['ID', 'DATE_MODIFY'], order: { ID: 'ASC' }, start: 0,
		}),
		stageHistoryByCreatedTime: await incrementalProbe('crm.stagehistory.list', {
			entityTypeId: 2, filter: { '>=CREATED_TIME': since }, select: ['ID', 'CREATED_TIME'], order: { ID: 'ASC' }, start: 0,
		}),
		activitiesByLastUpdated: await incrementalProbe('crm.activity.list', {
			filter: { OWNER_TYPE_ID: 2, '>=LAST_UPDATED': since }, select: ['ID', 'LAST_UPDATED'], order: { ID: 'ASC' }, start: 0,
		}),
	};

	console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
	console.error(errorInfo(error));
	process.exitCode = 1;
});
