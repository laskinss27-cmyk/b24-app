import { hasDirectMarketplaceAccess, hasMarketplaceBundlePriceAccess, accessV3Permissions, type AccessV3BaselineCell, type AccessV3Directory, type AccessV3Draft, type AccessV3Person } from '@b24-app/shared';
import { catalogAccessForUser } from './catalog-access.js';

/** Only static legacy rules we can establish from code. Never guess CRM/object-level access. */
function legacyCells(user: AccessV3Person, stores: string[]): Record<string, AccessV3BaselineCell> {
	const cells = Object.fromEntries(accessV3Permissions(stores).map(p => [p.id, { value: 'context', reason: p.warehouse
		? 'Доступ к конкретному складу ещё не сверен; сохраняется прежнее поведение'
		: 'Зависит от Битрикса, документа или нескольких проверок; сохраняется прежнее поведение' }])) as Record<string, AccessV3BaselineCell>;
	const stockManager = ['1', '986', '1858'].includes(user.id) || user.departments.includes(10);
	const catalog = catalogAccessForUser({ ID: user.id, NAME: user.firstName ?? '', LAST_NAME: user.lastName ?? '', UF_DEPARTMENT: user.departments });
	const set = (ids: string[], allowed: boolean, reason: string): void => {
		for (const id of ids) cells[id] = { value: allowed ? 'allow' : 'deny', reason };
	};
	set(['stock.create_receipt', 'stock.create_issue', 'stock.post_documents', 'supply.view', 'supply.edit_request_note', 'supply.edit_request_store'], stockManager, 'Текущее правило: снабжение и складские администраторы');
	// Portal ADMIN can add card editing rights and is not reliably exposed by user.get.
	if (catalog.canCreateProduct) set(['catalog.create'], true, 'Текущее правило каталога, включая личные исключения');
	if (catalog.canEditCard) set(['catalog.edit_card'], true, 'Текущее правило редактирования каталога');
	set(['catalog.edit_purchase_prices', 'catalog.edit_retail_prices'], catalog.canEditPrices, 'Текущее правило цен: снабжение или персональное исключение');
	const marketplace = stockManager || hasDirectMarketplaceAccess(user.id);
	set(['marketplaces.view', 'marketplaces.create_sale', 'marketplaces.post_sale', 'marketplaces.create_return', 'marketplaces.post_return', 'marketplaces.create_bundle'], marketplace, 'Текущее правило маркетплейсов, включая личные исключения');
	if (hasMarketplaceBundlePriceAccess(user.id, user.departments)) set(['marketplaces.edit_bundle_prices'], true, 'Текущее право отдела маркетплейсов или личное исключение');
	return cells;
}

export function seedAccessV3(directory: AccessV3Directory): AccessV3Draft {
	const departments = Object.fromEntries(directory.departments.map(d => [String(d.id), legacyCells({ id: '0', name: d.name, departments: [d.id] }, directory.stores)]));
	// Inherited fallback must exclude personal exceptions, so removing one really restores the department baseline.
	const users = Object.fromEntries(directory.users.map(u => [u.id, legacyCells({ id: '0', name: '', departments: u.departments }, directory.stores)]));
	const employees: AccessV3Draft['employees'] = {};
	// Preserve confirmed hard-coded personal exceptions rather than broadening their department.
	for (const user of directory.users) {
		const actualCells = legacyCells(user, directory.stores);
		for (const permission of accessV3Permissions(directory.stores)) {
			const actual = actualCells[permission.id]!;
			if (actual.value !== 'context' && users[user.id]![permission.id]!.value !== actual.value) {
				(employees[user.id] ??= {})[permission.id] = actual.value;
			}
		}
	}
	return { version: 3, mode: 'draft', revision: 0, departments: {}, employees,
		baseline: { capturedAt: new Date().toISOString(), directoryFingerprint: directory.fingerprint, users, departments }, updatedAt: null, updatedBy: null };
}
