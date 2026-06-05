import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getContext } from './b24-context.js';
import { DealProductsTab } from './DealProductsTab.js';
import { ProductBase } from './ProductBase.js';
import { MobileCount } from './MobileCount.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
	throw new Error('Root element #root not found');
}

// Один бандл, три входа:
//  - view='mobileCount' (/m, телефон вне iframe) → мобильный подсчёт точки из QR;
//  - view='inventory' (placement левого меню) → База товаров / инвентаризация;
//  - dealId (placement сделки) → вкладка товаров сделки.
// ProductBase сам решает по канарейке: бета (Сергей) → База товаров, остальные → GA-инвентаризация.
const ctx = getContext();

createRoot(root).render(
	<StrictMode>
		{ctx.view === 'mobileCount' ? <MobileCount /> : ctx.view === 'inventory' ? <ProductBase /> : <DealProductsTab />}
	</StrictMode>,
);
