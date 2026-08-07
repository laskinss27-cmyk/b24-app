import { useState } from 'react';

export function useDealProductsRefresh(onReload: () => Promise<void>) {
	const [refreshing, setRefreshing] = useState(false);
	const refresh = async (): Promise<void> => {
		if (refreshing) return;
		setRefreshing(true);
		try {
			await onReload();
		} finally {
			setRefreshing(false);
		}
	};
	return { refreshing, refresh };
}
