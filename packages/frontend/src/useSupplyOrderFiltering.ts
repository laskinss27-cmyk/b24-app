import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { SupplyOrderRow } from './b24.js';
import { orderSearchValues, searchMatches } from './supply-search-values.js';
import { orderMatchesStatusFilter, type OrderStatusFilter } from './supply-order-status-filter.js';
import type { SortKey } from './SupplyOrdersView.js';

type SupplyOrderFiltering = {
	sort: SortKey;
	setSort: Dispatch<SetStateAction<SortKey>>;
	orderStatusFilter: OrderStatusFilter;
	setOrderStatusFilter: Dispatch<SetStateAction<OrderStatusFilter>>;
	filteredOrders: SupplyOrderRow[];
};

export function useSupplyOrderFiltering(orders: SupplyOrderRow[], search: string): SupplyOrderFiltering {
	const [sort, setSort] = useState<SortKey>('dateDesc');
	const [orderStatusFilter, setOrderStatusFilter] = useState<OrderStatusFilter>([]);
	const requestOrders = useMemo(() => orders.filter((order) => !order.standalone), [orders]);
	const sortedOrders = useMemo(() => [...requestOrders].sort((a, b) => {
		if (sort === 'dateAsc') return String(a.date).localeCompare(String(b.date));
		if (sort === 'store') return String(a.toStore).localeCompare(String(b.toStore), 'ru');
		if (sort === 'deal') return String(a.dealTitle || a.dealId).localeCompare(String(b.dealTitle || b.dealId), 'ru');
		return String(b.date).localeCompare(String(a.date));
	}), [requestOrders, sort]);
	const filteredOrders = useMemo(
		() => sortedOrders.filter((order) =>
			orderMatchesStatusFilter(order, orderStatusFilter)
			&& searchMatches(search, orderSearchValues(order))),
		[orderStatusFilter, search, sortedOrders],
	);

	return {
		sort,
		setSort,
		orderStatusFilter,
		setOrderStatusFilter,
		filteredOrders,
	};
}
