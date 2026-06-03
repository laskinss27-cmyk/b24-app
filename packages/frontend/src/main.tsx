import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getContext } from './b24-context.js';
import { DealProductsTab } from './DealProductsTab.js';
import { ProductBase } from './ProductBase.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
	throw new Error('Root element #root not found');
}

// Один бандл, два входа: левое меню (База товаров / инвентаризация) vs сделка (товары).
// Бэкенд инжектит либо view='inventory' (placement левого меню), либо dealId (placement сделки).
// ProductBase сам решает по канарейке: бета (Сергей) → База товаров, остальные → GA-инвентаризация.
const ctx = getContext();

createRoot(root).render(
	<StrictMode>
		{ctx.view === 'inventory' ? <ProductBase /> : <DealProductsTab />}
	</StrictMode>,
);
