import { accessV3Permissions, type AccessV3Response } from '@b24-app/shared';

export function accessV3Demo(): AccessV3Response {
	const directory = { fingerprint: 'demo-only', stores: ['Shelly', 'Маркетплейс'], departments: [{ id: 10, name: 'Снабжение' }, { id: 20, name: 'Розничная торговля' }],
		users: [{ id: '101', name: 'Анна — пример менеджера', departments: [20] }, { id: '102', name: 'Иван — пример менеджера', departments: [20] }, { id: '103', name: 'Ольга — пример снабжения', departments: [10] }] };
	const cells = (supply: boolean) => Object.fromEntries(accessV3Permissions(directory.stores).map(p => [p.id, { value: p.id.startsWith('warehouse:') ? 'context' as const : supply ? 'allow' as const : 'deny' as const, reason: 'Демонстрационные данные — не реальные права' }]));
	return { directory, history: [], draft: { version: 3, mode: 'draft', revision: 0, departments: {}, employees: {},
		baseline: { capturedAt: new Date().toISOString(), directoryFingerprint: directory.fingerprint, users: { '101': cells(false), '102': cells(false), '103': cells(true) }, departments: { '10': cells(true), '20': cells(false) } }, updatedAt: null, updatedBy: null } };
}
