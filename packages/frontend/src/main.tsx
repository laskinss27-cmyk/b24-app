import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getContext } from './b24-context.js';
import { DealProductsTab } from './DealProductsTab.js';
import { ProductBase } from './ProductBase.js';
import { MobileCount } from './MobileCount.js';
import { SalesReport } from './SalesReport.js';
import { Repairs } from './Repairs.js';
import { StockLedger } from './StockLedger.js';
import { Supply } from './Supply.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
	throw new Error('Root element #root not found');
}

// Один бандл, три входа:
//  - view='mobileCount' (/m, телефон вне iframe) → мобильный подсчёт точки из QR;
//  - view='inventory' (placement левого меню) → База товаров / инвентаризация;
//  - dealId (placement сделки) → вкладка товаров сделки.
// Разделы сами применяют ролевые права текущей учётной записи.
const ctx = getContext();
const repairId = Number(new URLSearchParams(window.location.search).get('repairId') ?? 0);
const opensRepair = (Number.isInteger(repairId) && repairId > 0) || (Number.isInteger(ctx.repairId) && Number(ctx.repairId) > 0);

createRoot(root).render(
	<StrictMode>
		{opensRepair || ctx.view === 'repairs' ? <Repairs /> : ctx.view === 'mobileCount' ? <MobileCount /> : ctx.view === 'salesReport' ? <SalesReport /> : ctx.view === 'stock' ? <StockLedger /> : ctx.view === 'supply' ? <Supply /> : ctx.view === 'inventory' ? <ProductBase /> : <DealProductsTab />}
	</StrictMode>,
);
