import { hasDirectCatalogProductCreateAccess, SUPPLY_DEPARTMENT_ID } from '@b24-app/shared';

export interface CatalogAccess {
	canCreateProduct: boolean;
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

const CATALOG_ADMIN_USER_IDS = new Set([1858, 986, 1]);
export const CATALOG_KONSTANTIN_LASKIN_USER_ID = 1246;
export const CATALOG_EGOR_KABARDIN_USER_ID = 22;
const CATALOG_PRODUCT_CREATOR_USER_IDS = new Set([
	CATALOG_KONSTANTIN_LASKIN_USER_ID,
	CATALOG_EGOR_KABARDIN_USER_ID,
]);

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
	const isKonstantinLaskin = Number(user?.ID) === CATALOG_KONSTANTIN_LASKIN_USER_ID
		|| (
			normalized(user?.NAME) === normalized('Константин')
			&& normalized(user?.LAST_NAME) === normalized('Ласкин')
		);
	const canEditPrices = departments.includes(SUPPLY_DEPARTMENT_ID) || isKonstantinLaskin;
	const isPortalAdmin = user?.ADMIN === true || String(user?.ADMIN ?? '').toUpperCase() === 'Y';
	const canEditCard = canEditPrices || isPortalAdmin || CATALOG_ADMIN_USER_IDS.has(Number(user?.ID));
	return {
		canCreateProduct: canEditCard
			|| CATALOG_PRODUCT_CREATOR_USER_IDS.has(Number(user?.ID))
			|| hasDirectCatalogProductCreateAccess(user?.ID),
		canEditPrices,
		canEditCard,
	};
}

/**
 * Системная запись в каталог — узкое исключение только для конкретных учётных
 * записей, которым разрешено создание. Совпадения имени недостаточно.
 */
export function canDelegateCatalogProductCreation(user: CatalogAccessUser | null): boolean {
	return CATALOG_PRODUCT_CREATOR_USER_IDS.has(Number(user?.ID))
		|| hasDirectCatalogProductCreateAccess(user?.ID);
}
