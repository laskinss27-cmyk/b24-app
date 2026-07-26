/**
 * Черновая модель будущих прав приложения.
 *
 * ВАЖНО: пока policyMode всегда `draft`. Эти настройки сохраняются и показываются
 * руководству, но не участвуют в проверках рабочих API — действующие права остаются
 * ровно такими, какими были до появления окна.
 */
export type AccessDecision = 'inherit' | 'allow' | 'deny';

export type AccessPermissionId =
	| 'catalog.view'
	| 'catalog.create'
	| 'catalog.edit_card'
	| 'catalog.edit_prices'
	| 'deals.view'
	| 'deals.edit_products'
	| 'deals.reserve'
	| 'stock.view'
	| 'stock.create_documents'
	| 'stock.post_documents'
	| 'transfers.create_request'
	| 'transfers.create'
	| 'transfers.collect'
	| 'transfers.receive'
	| 'transfers.post'
	| 'transfers.delete'
	| 'supply.view'
	| 'supply.manage_requests'
	| 'supply.manage_purchases'
	| 'supply.delete_documents'
	| 'repairs.view'
	| 'repairs.edit'
	| 'repairs.edit_prices'
	| 'repairs.change_status'
	| 'repairs.delete'
	| 'reports.sales'
	| 'reports.realizations'
	| 'admin.manage_access';

export interface AccessPermissionDefinition {
	id: AccessPermissionId;
	group: string;
	label: string;
	dangerous?: boolean;
}

export const ACCESS_PERMISSIONS: readonly AccessPermissionDefinition[] = [
	{ id: 'catalog.view', group: 'Каталог', label: 'Просматривать каталог' },
	{ id: 'catalog.create', group: 'Каталог', label: 'Создавать товары', dangerous: true },
	{ id: 'catalog.edit_card', group: 'Каталог', label: 'Редактировать карточки товаров', dangerous: true },
	{ id: 'catalog.edit_prices', group: 'Каталог', label: 'Изменять цены', dangerous: true },
	{ id: 'deals.view', group: 'Сделки', label: 'Просматривать состав сделок' },
	{ id: 'deals.edit_products', group: 'Сделки', label: 'Изменять состав сделок', dangerous: true },
	{ id: 'deals.reserve', group: 'Сделки', label: 'Создавать и менять резервы', dangerous: true },
	{ id: 'stock.view', group: 'Склад', label: 'Просматривать складской учёт' },
	{ id: 'stock.create_documents', group: 'Склад', label: 'Создавать складские документы', dangerous: true },
	{ id: 'stock.post_documents', group: 'Склад', label: 'Проводить складские документы', dangerous: true },
	{ id: 'transfers.create_request', group: 'Перемещения', label: 'Создавать заявки на перемещение' },
	{ id: 'transfers.create', group: 'Перемещения', label: 'Создавать перемещения', dangerous: true },
	{ id: 'transfers.collect', group: 'Перемещения', label: 'Отмечать сборку' },
	{ id: 'transfers.receive', group: 'Перемещения', label: 'Принимать перемещения' },
	{ id: 'transfers.post', group: 'Перемещения', label: 'Проводить перемещения', dangerous: true },
	{ id: 'transfers.delete', group: 'Перемещения', label: 'Удалять перемещения', dangerous: true },
	{ id: 'supply.view', group: 'Снабжение', label: 'Открывать рабочее место снабжения' },
	{ id: 'supply.manage_requests', group: 'Снабжение', label: 'Обрабатывать заявки' },
	{ id: 'supply.manage_purchases', group: 'Снабжение', label: 'Создавать и менять закупки', dangerous: true },
	{ id: 'supply.delete_documents', group: 'Снабжение', label: 'Удалять документы снабжения', dangerous: true },
	{ id: 'repairs.view', group: 'Ремонты', label: 'Просматривать ремонты' },
	{ id: 'repairs.edit', group: 'Ремонты', label: 'Редактировать ремонты' },
	{ id: 'repairs.edit_prices', group: 'Ремонты', label: 'Изменять цены ремонта', dangerous: true },
	{ id: 'repairs.change_status', group: 'Ремонты', label: 'Изменять статусы ремонта' },
	{ id: 'repairs.delete', group: 'Ремонты', label: 'Удалять ремонты', dangerous: true },
	{ id: 'reports.sales', group: 'Отчёты', label: 'Открывать отчёт по продажам' },
	{ id: 'reports.realizations', group: 'Отчёты', label: 'Открывать реализации' },
	{ id: 'admin.manage_access', group: 'Администрирование', label: 'Настраивать права сотрудников', dangerous: true },
] as const;

export type AccessProfileId = 'legacy' | 'manager' | 'supply' | 'service' | 'leadership';

export interface AccessProfileDefinition {
	id: AccessProfileId;
	label: string;
	description: string;
	decisions: Partial<Record<AccessPermissionId, Exclude<AccessDecision, 'inherit'>>>;
}

const allow = (...ids: AccessPermissionId[]): Partial<Record<AccessPermissionId, 'allow'>> =>
	Object.fromEntries(ids.map((id) => [id, 'allow'])) as Partial<Record<AccessPermissionId, 'allow'>>;

export const ACCESS_PROFILES: readonly AccessProfileDefinition[] = [
	{
		id: 'legacy',
		label: 'Текущие права',
		description: 'Ничего не меняет: сотрудник продолжает работать по действующим правилам.',
		decisions: {},
	},
	{
		id: 'manager',
		label: 'Менеджер',
		description: 'Каталог, сделки, заявки на перемещение и обычная работа с ремонтами.',
		decisions: allow('catalog.view', 'deals.view', 'deals.edit_products', 'deals.reserve', 'stock.view', 'transfers.create_request', 'repairs.view', 'repairs.edit', 'repairs.change_status'),
	},
	{
		id: 'supply',
		label: 'Снабжение',
		description: 'Работа с каталогом, складом, перемещениями, закупками и ремонтами.',
		decisions: allow('catalog.view', 'catalog.create', 'catalog.edit_card', 'catalog.edit_prices', 'stock.view', 'stock.create_documents', 'stock.post_documents', 'transfers.create', 'transfers.collect', 'transfers.receive', 'transfers.post', 'supply.view', 'supply.manage_requests', 'supply.manage_purchases', 'repairs.view', 'repairs.edit', 'repairs.edit_prices', 'repairs.change_status'),
	},
	{
		id: 'service',
		label: 'Сервис',
		description: 'Работа с ремонтами без доступа к закупочным и складским операциям.',
		decisions: allow('catalog.view', 'repairs.view', 'repairs.edit', 'repairs.change_status'),
	},
	{
		id: 'leadership',
		label: 'Руководитель',
		description: 'Просмотр всех разделов, отчёты и управление рабочими операциями.',
		decisions: allow(...ACCESS_PERMISSIONS.filter((item) => item.id !== 'admin.manage_access').map((item) => item.id)),
	},
] as const;

export interface EmployeeAccessDraft {
	profileId: AccessProfileId;
	overrides: Partial<Record<AccessPermissionId, Exclude<AccessDecision, 'inherit'>>>;
	note?: string;
}

export interface AccessAuditEntry {
	at: string;
	byId: string;
	byName: string;
	changedUserIds: string[];
}

export interface AccessControlDraft {
	version: 1;
	revision: number;
	policyMode: 'draft';
	employees: Record<string, EmployeeAccessDraft>;
	updatedAt: string | null;
	updatedById: string | null;
	updatedByName: string | null;
	audit: AccessAuditEntry[];
}

export function emptyAccessControlDraft(): AccessControlDraft {
	return {
		version: 1,
		revision: 0,
		policyMode: 'draft',
		employees: {},
		updatedAt: null,
		updatedById: null,
		updatedByName: null,
		audit: [],
	};
}

/** Явный индивидуальный запрет/доступ сильнее профиля. */
export function effectiveDraftDecision(
	employee: EmployeeAccessDraft | undefined,
	permissionId: AccessPermissionId,
): AccessDecision {
	const override = employee?.overrides[permissionId];
	if (override) return override;
	const profile = ACCESS_PROFILES.find((item) => item.id === (employee?.profileId ?? 'legacy'));
	return profile?.decisions[permissionId] ?? 'inherit';
}
