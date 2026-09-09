import type { Inventory } from './inventory-api.js';
import { defaultInventoryListFilters, inventoryListStores, type InventoryListFilters as Filters } from './inventory-list.js';

export function InventoryListFilters({ inventories, value, onChange, shown, loading, onRefresh }: {
	inventories: Inventory[]; value: Filters; onChange: (value: Filters) => void; shown: number; loading: boolean; onRefresh: () => void;
}): JSX.Element {
	return <section aria-label="Фильтры инвентаризаций" className="inv-card">
		<div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
			<label className="inv-field">Статус <select value={value.status} onChange={e => onChange({ ...value, status: e.target.value as Filters['status'] })}>
				<option value="all">Все ({inventories.length})</option>
				<option value="active">Активные ({inventories.filter(inv => inv.status === 'active').length})</option>
				<option value="closed">Завершённые ({inventories.filter(inv => inv.status === 'closed').length})</option>
			</select></label>
			<label className="inv-field">Склад <select value={value.store} onChange={e => onChange({ ...value, store: e.target.value })}>
				<option value="">Все склады</option>
				{value.store && !inventoryListStores(inventories).some(store => store.id === value.store) && <option value={value.store}>Склад #{value.store} (нет в загруженном списке)</option>}
				{inventoryListStores(inventories).map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
			</select></label>
			<label className="inv-field">Поиск <input type="search" placeholder="Название, номер, склад, ответственный" value={value.search} onChange={e => onChange({ ...value, search: e.target.value })} /></label>
			<label className="inv-field">Сортировка <select value={value.sort} onChange={e => onChange({ ...value, sort: e.target.value as Filters['sort'] })}>
				<option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option><option value="deadline">По сроку сдачи</option>
			</select></label>
			<button type="button" className="btn-secondary" onClick={() => onChange({ ...defaultInventoryListFilters })}>Сбросить фильтры</button>
			<button type="button" className="btn-secondary" disabled={loading} onClick={onRefresh}>{loading ? 'Загружаю…' : 'Обновить список'}</button>
		</div>
		<p role="status">Показано {shown} из {inventories.length} загруженных инвентаризаций.{value.store ? ' Карточки показаны целиком, включая другие склады этой инвентаризации.' : ''}</p>
	</section>;
}
