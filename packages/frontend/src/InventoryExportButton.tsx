import { useState } from 'react';
import { downloadInventoryExcel } from './inventory-export.js';

export function InventoryExportButton({ inventoryId, storeId }: { inventoryId: string; storeId?: number }): JSX.Element {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const download = async (): Promise<void> => {
		setBusy(true);
		setError('');
		try { await downloadInventoryExcel(inventoryId, storeId); }
		catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
		finally { setBusy(false); }
	};
	return <span className="inventory-export">
		<button type="button" className="btn-mini ghost" disabled={busy} onClick={() => void download()}
			title={storeId === undefined ? 'Скачать сохранённые данные всех складов этой инвентаризации' : 'Скачать сохранённые данные этого склада'}>
			{busy ? 'Готовлю Excel…' : storeId === undefined ? 'Скачать Excel' : 'Excel склада'}
		</button>
		{error && <span className="inventory-export-error" role="alert">{error}</span>}
	</span>;
}
