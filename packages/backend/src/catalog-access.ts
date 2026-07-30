export interface CatalogAccess {
	canEditCard: boolean;
	canEditPrices: boolean;
}

export interface CatalogAccessUser {
	ID?: string | number;
	NAME?: string;
	LAST_NAME?: string;
	UF_DEPARTMENT?: unknown;
	ADMIN?: boolean | string;
}

const SUPPLY_DEPARTMENT_ID = 10;
const CATALOG_ADMIN_USER_IDS = new Set([1858, 986, 1]);

function normalized(value: unknown): string {
	return String(value ?? '')
		.trim()
		.toLocaleLowerCase('ru-RU')
		.replace(/ё/g, 'е')
		.replace(/[^a-zа-я0-9]+/gi, '');
}

export function catalogAccessForUser(user: CatalogAccessUser | null): CatalogAccess {
	const departments = Array.isArray(user?.UF_DEPARTMENT)
		? (user.UF_DEPARTMENT as unknown[]).map(Number)
		: [Number(user?.UF_DEPARTMENT)];
	const isKonstantinLaskin = normalized(user?.NAME) === normalized('Константин')
		&& normalized(user?.LAST_NAME) === normalized('Ласкин');
	const canEditPrices = departments.includes(SUPPLY_DEPARTMENT_ID) || isKonstantinLaskin;
	const isPortalAdmin = user?.ADMIN === true || String(user?.ADMIN ?? '').toUpperCase() === 'Y';
	return {
		canEditPrices,
		canEditCard: canEditPrices || isPortalAdmin || CATALOG_ADMIN_USER_IDS.has(Number(user?.ID)),
	};
}
