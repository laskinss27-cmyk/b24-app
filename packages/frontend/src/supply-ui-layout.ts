import { type SupplyViewKey } from './SupplyNavigation.js';

export const SUPPLY_UI_LAYOUT_STORAGE_KEY = 'b24-app:supply-ui-layout:v1';

export const SUPPLY_ACTION_IDS = [
	'create-purchase',
	'create-transfer',
	'create-issue',
	'create-receipt',
] as const;

export type SupplyActionId = (typeof SUPPLY_ACTION_IDS)[number];
export type SupplyActionZone = 'header' | 'toolbar';

const SUPPLY_ACTION_VIEWS: Record<SupplyActionId, SupplyViewKey> = {
	'create-purchase': 'purchase',
	'create-transfer': 'logistics',
	'create-issue': 'issue',
	'create-receipt': 'receipt',
};

export function supplyActionIdsForView(view: SupplyViewKey): SupplyActionId[] {
	return SUPPLY_ACTION_IDS.filter((actionId) => SUPPLY_ACTION_VIEWS[actionId] === view);
}

export interface SupplyUiLayout {
	version: 1;
	zones: Record<SupplyActionZone, SupplyActionId[]>;
}

export const DEFAULT_SUPPLY_UI_LAYOUT: SupplyUiLayout = {
	version: 1,
	zones: {
		header: [...SUPPLY_ACTION_IDS],
		toolbar: [],
	},
};

function copyLayout(layout: SupplyUiLayout): SupplyUiLayout {
	return {
		version: 1,
		zones: {
			header: [...layout.zones.header],
			toolbar: [...layout.zones.toolbar],
		},
	};
}

function isActionId(value: unknown): value is SupplyActionId {
	return typeof value === 'string' && (SUPPLY_ACTION_IDS as readonly string[]).includes(value);
}

export function normalizeSupplyUiLayout(value: unknown): SupplyUiLayout {
	if (!value || typeof value !== 'object') return copyLayout(DEFAULT_SUPPLY_UI_LAYOUT);

	const candidate = value as { zones?: { header?: unknown; toolbar?: unknown } };
	const seen = new Set<SupplyActionId>();
	const normalizeZone = (zone: unknown): SupplyActionId[] => {
		if (!Array.isArray(zone)) return [];
		return zone.filter((item): item is SupplyActionId => {
			if (!isActionId(item) || seen.has(item)) return false;
			seen.add(item);
			return true;
		});
	};

	const header = normalizeZone(candidate.zones?.header);
	const toolbar = normalizeZone(candidate.zones?.toolbar);
	for (const actionId of SUPPLY_ACTION_IDS) {
		if (!seen.has(actionId)) header.push(actionId);
	}

	return { version: 1, zones: { header, toolbar } };
}

export function loadSupplyUiLayout(storage?: Pick<Storage, 'getItem'>): SupplyUiLayout {
	try {
		const targetStorage = storage ?? globalThis.localStorage;
		const saved = targetStorage.getItem(SUPPLY_UI_LAYOUT_STORAGE_KEY);
		return saved ? normalizeSupplyUiLayout(JSON.parse(saved) as unknown) : copyLayout(DEFAULT_SUPPLY_UI_LAYOUT);
	} catch {
		return copyLayout(DEFAULT_SUPPLY_UI_LAYOUT);
	}
}

export function saveSupplyUiLayout(layout: SupplyUiLayout, storage?: Pick<Storage, 'setItem'>): SupplyUiLayout {
	const normalized = normalizeSupplyUiLayout(layout);
	try {
		const targetStorage = storage ?? globalThis.localStorage;
		targetStorage.setItem(SUPPLY_UI_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
	} catch {
		// The interface should remain usable when browser storage is unavailable.
	}
	return normalized;
}

export function moveSupplyAction(
	layout: SupplyUiLayout,
	actionId: SupplyActionId,
	targetZone: SupplyActionZone,
	targetIndex?: number,
): SupplyUiLayout {
	const zones: Record<SupplyActionZone, SupplyActionId[]> = {
		header: layout.zones.header.filter((id) => id !== actionId),
		toolbar: layout.zones.toolbar.filter((id) => id !== actionId),
	};
	const index = Math.max(0, Math.min(targetIndex ?? zones[targetZone].length, zones[targetZone].length));
	zones[targetZone].splice(index, 0, actionId);
	return normalizeSupplyUiLayout({ version: 1, zones });
}

export function resetSupplyUiLayout(): SupplyUiLayout {
	return copyLayout(DEFAULT_SUPPLY_UI_LAYOUT);
}
