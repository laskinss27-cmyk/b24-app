import { bx24Auth } from './bitrix-auth.js';

export async function fetchInventoryExcel(inventoryId: string, storeId?: number): Promise<Blob> {
	const auth = bx24Auth();
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await fetch('/api/inventory/export-xlsx', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...auth, inventoryId, ...(storeId !== undefined ? { storeId } : {}),
				...(attempt && 'mobileSession' in auth ? { mobileRefresh: true } : {}) }),
		});
		if (response.ok && response.headers.get('content-type')?.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
			return response.blob();
		}
		const error = await response.json().catch(() => null) as { error?: string } | null;
		if (!attempt && 'mobileSession' in auth && /expired_token/i.test(error?.error ?? '')) continue;
		throw new Error(error?.error || 'Не удалось скачать Excel. Попробуйте ещё раз.');
	}
	throw new Error('Не удалось скачать Excel');
}

export async function downloadInventoryExcel(inventoryId: string, storeId?: number): Promise<void> {
	const blob = await fetchInventoryExcel(inventoryId, storeId);
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = `Инвентаризация-${inventoryId}${storeId !== undefined ? `-склад-${storeId}` : ''}.xlsx`;
	document.body.appendChild(link);
	try { link.click(); }
	finally {
		link.remove();
		// Give the browser time to start the download before releasing the Blob.
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}
}
