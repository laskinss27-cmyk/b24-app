/**
 * Права самого приложения.
 *
 * Если для сотрудника и его отделов ничего не настроено, решение остаётся `inherit`:
 * продолжают действовать прежние ролевые правила. Это позволяет включать новую модель
 * постепенно, не блокируя работающих сотрудников.
 */
export type AccessDecision = 'inherit' | 'allow' | 'deny';

export interface AccessPermissionDefinition {
	id: string;
	group: string;
	label: string;
	dangerous?: boolean;
}

export const ACCESS_PERMISSIONS = [
	{ id: 'catalog.view', group: 'Каталог', label: 'Открывать каталог' },
	{ id: 'catalog.search', group: 'Каталог', label: 'Искать и фильтровать товары' },
	{ id: 'catalog.view_purchase_prices', group: 'Каталог', label: 'Видеть закупочные цены' },
	{ id: 'catalog.view_all_stores', group: 'Каталог', label: 'Видеть остатки всех складов' },
	{ id: 'catalog.create', group: 'Каталог', label: 'Создавать товары', dangerous: true },
	{ id: 'catalog.edit_card', group: 'Каталог', label: 'Редактировать карточки товаров', dangerous: true },
	{ id: 'catalog.edit_descriptions', group: 'Каталог', label: 'Редактировать описания и характеристики', dangerous: true },
	{ id: 'catalog.edit_retail_prices', group: 'Каталог', label: 'Изменять розничные цены', dangerous: true },
	{ id: 'catalog.edit_purchase_prices', group: 'Каталог', label: 'Изменять закупочные цены', dangerous: true },
	{ id: 'catalog.export_comparison', group: 'Каталог', label: 'Выгружать сравнение товаров' },
	{ id: 'catalog.print_price_tags', group: 'Каталог', label: 'Печатать ценники' },

	{ id: 'deals.view', group: 'Сделки', label: 'Просматривать состав сделок' },
	{ id: 'deals.view_purchase_prices', group: 'Сделки', label: 'Видеть закупочные цены и маржу' },
	{ id: 'deals.add_products', group: 'Сделки', label: 'Добавлять товары в сделку', dangerous: true },
	{ id: 'deals.edit_quantity', group: 'Сделки', label: 'Изменять количество товаров', dangerous: true },
	{ id: 'deals.edit_prices', group: 'Сделки', label: 'Изменять цены в сделке', dangerous: true },
	{ id: 'deals.apply_discount', group: 'Сделки', label: 'Применять скидки', dangerous: true },
	{ id: 'deals.remove_products', group: 'Сделки', label: 'Удалять товары из сделки', dangerous: true },
	{ id: 'deals.reserve', group: 'Сделки', label: 'Создавать и изменять резервы', dangerous: true },
	{ id: 'deals.change_source_store', group: 'Сделки', label: 'Менять склад отгрузки', dangerous: true },
	{ id: 'deals.create_supply_request', group: 'Сделки', label: 'Создавать заявку снабжению' },
	{ id: 'deals.export_xlsx', group: 'Сделки', label: 'Выгружать состав сделки в Excel' },
	{ id: 'deals.create_quote', group: 'Сделки', label: 'Формировать коммерческое предложение' },
	{ id: 'deals.create_contract', group: 'Сделки', label: 'Формировать договор' },

	{ id: 'realizations.view', group: 'Реализации', label: 'Просматривать реализации' },
	{ id: 'realizations.create', group: 'Реализации', label: 'Создавать реализацию', dangerous: true },
	{ id: 'realizations.edit_draft', group: 'Реализации', label: 'Редактировать черновик реализации', dangerous: true },
	{ id: 'realizations.post', group: 'Реализации', label: 'Проводить реализацию', dangerous: true },
	{ id: 'realizations.return', group: 'Реализации', label: 'Оформлять возврат реализации', dangerous: true },
	{ id: 'realizations.cancel', group: 'Реализации', label: 'Отменять проведение реализации', dangerous: true },
	{ id: 'realizations.delete', group: 'Реализации', label: 'Удалять черновик реализации', dangerous: true },

	{ id: 'stock.view', group: 'Склад', label: 'Просматривать складской учёт' },
	{ id: 'stock.view_movements', group: 'Склад', label: 'Просматривать движения товара' },
	{ id: 'stock.view_purchase_prices', group: 'Склад', label: 'Видеть закупочные цены' },
	{ id: 'stock.create_receipt', group: 'Склад', label: 'Создавать приход товара', dangerous: true },
	{ id: 'stock.create_issue', group: 'Склад', label: 'Создавать списание товара', dangerous: true },
	{ id: 'stock.edit_draft', group: 'Склад', label: 'Редактировать черновики документов', dangerous: true },
	{ id: 'stock.post_documents', group: 'Склад', label: 'Проводить складские документы', dangerous: true },
	{ id: 'stock.cancel_documents', group: 'Склад', label: 'Отменять складские документы', dangerous: true },
	{ id: 'stock.create_product', group: 'Склад', label: 'Создавать товар из складского документа', dangerous: true },

	{ id: 'transfers.view_own', group: 'Перемещения', label: 'Просматривать свои заявки' },
	{ id: 'transfers.view_all', group: 'Перемещения', label: 'Просматривать все заявки и перемещения' },
	{ id: 'transfers.create_request', group: 'Перемещения', label: 'Создавать заявку на перемещение' },
	{ id: 'transfers.cancel_own_request', group: 'Перемещения', label: 'Отменять свою заявку' },
	{ id: 'transfers.manage_requests', group: 'Перемещения', label: 'Обрабатывать заявки сотрудников', dangerous: true },
	{ id: 'transfers.create', group: 'Перемещения', label: 'Создавать перемещение', dangerous: true },
	{ id: 'transfers.edit_destination', group: 'Перемещения', label: 'Менять склад назначения', dangerous: true },
	{ id: 'transfers.edit_quantity', group: 'Перемещения', label: 'Изменять количество товара', dangerous: true },
	{ id: 'transfers.collect', group: 'Перемещения', label: 'Отмечать сборку' },
	{ id: 'transfers.ship', group: 'Перемещения', label: 'Отмечать отправку', dangerous: true },
	{ id: 'transfers.receive', group: 'Перемещения', label: 'Принимать перемещение', dangerous: true },
	{ id: 'transfers.post', group: 'Перемещения', label: 'Проводить перемещение', dangerous: true },
	{ id: 'transfers.resolve_shortage', group: 'Перемещения', label: 'Подтверждать недостачу или расхождение', dangerous: true },
	{ id: 'transfers.cancel', group: 'Перемещения', label: 'Отменять перемещение', dangerous: true },
	{ id: 'transfers.delete', group: 'Перемещения', label: 'Удалять перемещение', dangerous: true },

	{ id: 'supply.view', group: 'Снабжение', label: 'Открывать рабочее место снабжения' },
	{ id: 'supply.view_all_requests', group: 'Снабжение', label: 'Просматривать все заявки' },
	{ id: 'supply.edit_request_note', group: 'Снабжение', label: 'Редактировать комментарий к заявке' },
	{ id: 'supply.manage_requests', group: 'Снабжение', label: 'Обрабатывать и закрывать заявки', dangerous: true },
	{ id: 'supply.create_purchase', group: 'Снабжение', label: 'Создавать закупку', dangerous: true },
	{ id: 'supply.edit_purchase', group: 'Снабжение', label: 'Редактировать закупку', dangerous: true },
	{ id: 'supply.receive_purchase', group: 'Снабжение', label: 'Принимать закупку на склад', dangerous: true },
	{ id: 'supply.change_purchase_stage', group: 'Снабжение', label: 'Менять этап закупки', dangerous: true },
	{ id: 'supply.create_supplier', group: 'Снабжение', label: 'Создавать поставщика', dangerous: true },
	{ id: 'supply.delete_documents', group: 'Снабжение', label: 'Удалять документы снабжения', dangerous: true },

	{ id: 'repairs.view', group: 'Ремонты', label: 'Просматривать ремонты' },
	{ id: 'repairs.create', group: 'Ремонты', label: 'Создавать ремонт' },
	{ id: 'repairs.edit', group: 'Ремонты', label: 'Редактировать данные ремонта', dangerous: true },
	{ id: 'repairs.edit_internal_comment', group: 'Ремонты', label: 'Редактировать внутренний комментарий' },
	{ id: 'repairs.edit_prices', group: 'Ремонты', label: 'Изменять цены ремонта', dangerous: true },
	{ id: 'repairs.change_status', group: 'Ремонты', label: 'Изменять статус ремонта', dangerous: true },
	{ id: 'repairs.request_price_approval', group: 'Ремонты', label: 'Отправлять цену на согласование' },
	{ id: 'repairs.change_issue_store', group: 'Ремонты', label: 'Менять склад выдачи', dangerous: true },
	{ id: 'repairs.print_acceptance', group: 'Ремонты', label: 'Печатать акт приёма' },
	{ id: 'repairs.print_issue', group: 'Ремонты', label: 'Печатать акт выдачи' },
	{ id: 'repairs.delete', group: 'Ремонты', label: 'Удалять ремонт', dangerous: true },

	{ id: 'marketplaces.view', group: 'Маркетплейсы', label: 'Просматривать операции маркетплейсов' },
	{ id: 'marketplaces.create_sale', group: 'Маркетплейсы', label: 'Создавать продажу маркетплейса', dangerous: true },
	{ id: 'marketplaces.post_sale', group: 'Маркетплейсы', label: 'Проводить продажу маркетплейса', dangerous: true },
	{ id: 'marketplaces.create_return', group: 'Маркетплейсы', label: 'Создавать возврат маркетплейса', dangerous: true },
	{ id: 'marketplaces.post_return', group: 'Маркетплейсы', label: 'Проводить возврат маркетплейса', dangerous: true },
	{ id: 'marketplaces.create_bundle', group: 'Маркетплейсы', label: 'Создавать комплект товара', dangerous: true },

	{ id: 'reports.sales', group: 'Отчёты', label: 'Открывать отчёт по продажам' },
	{ id: 'reports.profit', group: 'Отчёты', label: 'Видеть прибыль и маржу' },
	{ id: 'reports.realizations', group: 'Отчёты', label: 'Открывать отчёт по реализациям' },
	{ id: 'reports.inventory', group: 'Отчёты', label: 'Открывать отчёт по остаткам' },
	{ id: 'reports.stock_movements', group: 'Отчёты', label: 'Открывать отчёт по движениям товара' },
	{ id: 'reports.export', group: 'Отчёты', label: 'Выгружать отчёты' },

	{ id: 'inventory.view', group: 'Инвентаризация', label: 'Открывать инвентаризации' },
	{ id: 'inventory.create', group: 'Инвентаризация', label: 'Создавать инвентаризацию', dangerous: true },
	{ id: 'inventory.count', group: 'Инвентаризация', label: 'Проводить пересчёт своей точки' },
	{ id: 'inventory.manage', group: 'Инвентаризация', label: 'Управлять точками и расхождениями', dangerous: true },
	{ id: 'inventory.post', group: 'Инвентаризация', label: 'Формировать и проводить документы', dangerous: true },
	{ id: 'inventory.delete', group: 'Инвентаризация', label: 'Удалять инвентаризацию', dangerous: true },

	{ id: 'admin.manage_access', group: 'Администрирование', label: 'Настраивать права сотрудников', dangerous: true },
	{ id: 'admin.view_access_audit', group: 'Администрирование', label: 'Просматривать историю изменения прав' },
	{ id: 'admin.manage_profiles', group: 'Администрирование', label: 'Настраивать базовые профили прав', dangerous: true },
] as const satisfies readonly AccessPermissionDefinition[];

export type AccessPermissionId = (typeof ACCESS_PERMISSIONS)[number]['id'];
export type AccessProfileId = 'legacy' | 'manager' | 'supply' | 'administrator' | 'leadership';

export interface AccessProfileDefinition {
	id: AccessProfileId;
	label: string;
	description: string;
	decisions: Partial<Record<AccessPermissionId, Exclude<AccessDecision, 'inherit'>>>;
}

const allow = (...ids: AccessPermissionId[]): Partial<Record<AccessPermissionId, 'allow'>> =>
	Object.fromEntries(ids.map((id) => [id, 'allow'])) as Partial<Record<AccessPermissionId, 'allow'>>;

const permissionsIn = (...groups: string[]): AccessPermissionId[] =>
	ACCESS_PERMISSIONS.filter((item) => groups.includes(item.group)).map((item) => item.id);

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
		description: 'Каталог, сделки, реализации, свои заявки на перемещение и обычная работа с ремонтом.',
		decisions: allow(
			'catalog.view', 'catalog.search', 'catalog.view_all_stores', 'catalog.export_comparison', 'catalog.print_price_tags',
			'deals.view', 'deals.add_products', 'deals.edit_quantity', 'deals.edit_prices', 'deals.apply_discount',
			'deals.remove_products', 'deals.reserve', 'deals.change_source_store', 'deals.create_supply_request',
			'deals.export_xlsx', 'deals.create_quote', 'deals.create_contract',
			'realizations.view', 'realizations.create', 'realizations.edit_draft', 'realizations.post', 'realizations.return',
			'stock.view', 'transfers.view_own', 'transfers.create_request', 'transfers.cancel_own_request',
			'repairs.view', 'repairs.create', 'repairs.edit', 'repairs.change_status', 'repairs.request_price_approval',
			'repairs.print_acceptance', 'repairs.print_issue',
		),
	},
	{
		id: 'supply',
		label: 'Снабжение',
		description: 'Полная рабочая зона каталога, склада, перемещений и закупок без административных настроек.',
		decisions: allow(
			...permissionsIn('Каталог', 'Склад', 'Перемещения', 'Снабжение'),
			'reports.stock_movements', 'reports.export',
		),
	},
	{
		id: 'administrator',
		label: 'Администратор',
		description: 'Полный доступ ко всем рабочим разделам и настройке прав приложения.',
		decisions: allow(...ACCESS_PERMISSIONS.map((item) => item.id)),
	},
	{
		id: 'leadership',
		label: 'Руководитель',
		description: 'Все рабочие действия и отчёты. Управление правами оставлено отдельным явным разрешением.',
		decisions: allow(...ACCESS_PERMISSIONS
			.filter((item) => !item.id.startsWith('admin.'))
			.map((item) => item.id)),
	},
] as const;

export interface AccessSubjectRule {
	profileId: AccessProfileId;
	overrides: Partial<Record<AccessPermissionId, Exclude<AccessDecision, 'inherit'>>>;
	note?: string;
}

/** Старое имя оставлено как совместимый алиас для существующих импортов. */
export type EmployeeAccessDraft = AccessSubjectRule;

export interface AccessAuditEntry {
	at: string;
	byId: string;
	byName: string;
	changedUserIds: string[];
	changedDepartmentIds?: string[];
}

export interface AccessControlDraft {
	version: 2;
	revision: number;
	policyMode: 'draft' | 'active';
	employees: Record<string, AccessSubjectRule>;
	departments: Record<string, AccessSubjectRule>;
	updatedAt: string | null;
	updatedById: string | null;
	updatedByName: string | null;
	audit: AccessAuditEntry[];
}

export function emptyAccessControlDraft(): AccessControlDraft {
	return {
		version: 2,
		revision: 0,
		policyMode: 'draft',
		employees: {},
		departments: {},
		updatedAt: null,
		updatedById: null,
		updatedByName: null,
		audit: [],
	};
}

/** Явный индивидуальный запрет/доступ сильнее профиля. */
export function effectiveDraftDecision(
	subject: AccessSubjectRule | undefined,
	permissionId: AccessPermissionId,
): AccessDecision {
	const override = subject?.overrides[permissionId];
	if (override) return override;
	const profileId = subject?.profileId ?? 'legacy';
	if (profileId === 'legacy') return 'inherit';
	const profile = ACCESS_PROFILES.find((item) => item.id === profileId);
	return profile?.decisions[permissionId] ?? 'deny';
}

/**
 * Приоритет: персональное правило → правила отделов → прежние права.
 * Между несколькими отделами безопасный запрет сильнее разрешения.
 */
export function effectiveAccessDecision(
	employee: AccessSubjectRule | undefined,
	departments: readonly (AccessSubjectRule | undefined)[],
	permissionId: AccessPermissionId,
): AccessDecision {
	const employeeDecision = effectiveDraftDecision(employee, permissionId);
	if (employeeDecision !== 'inherit') return employeeDecision;
	const departmentDecisions = departments.map((item) => effectiveDraftDecision(item, permissionId));
	if (departmentDecisions.includes('deny')) return 'deny';
	if (departmentDecisions.includes('allow')) return 'allow';
	return 'inherit';
}
