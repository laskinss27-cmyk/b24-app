import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getContext } from './b24-context.js';
import { DealProductsTab } from './DealProductsTab.js';
import { InventoryReport } from './InventoryReport.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
	throw new Error('Root element #root not found');
}

// Один бандл, два входа: задача (инвентаризация) vs сделка (товары).
// Бэкенд инжектит либо taskId (placement задачи), либо dealId (placement сделки).
const ctx = getContext();

createRoot(root).render(
	<StrictMode>
		{ctx.taskId != null ? <InventoryReport /> : <DealProductsTab />}
	</StrictMode>,
);
