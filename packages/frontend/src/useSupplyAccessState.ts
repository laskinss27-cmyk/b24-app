import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { hasDirectMarketplaceAccess } from '@b24-app/shared';
import {
	fetchCurrentAppAccess,
	fetchCurrentUserId,
	fetchStockFormData,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	type SupplyOrderRow,
	withRetry,
	withTimeout,
} from './b24.js';
import { MOCK_ORDERS } from './supply-mock-orders.js';
import type { SupplyViewKey } from './SupplyNavigation.js';

type SupplyPhase = 'init' | 'denied' | 'unavailable' | 'manager-link' | 'ready';
type SupplyStockForm = Awaited<ReturnType<typeof fetchStockFormData>>;

const supplyAccessCacheKey = (userId: string): string => `b24:supply-access:${userId}`;

function readCachedStockForm(userId: string): SupplyStockForm | null {
	if (!userId) return null;
	try {
		const raw = localStorage.getItem(supplyAccessCacheKey(userId));
		if (!raw) return null;
		const cached = JSON.parse(raw) as { expiresAt?: number; value?: SupplyStockForm };
		if (!cached.value || Number(cached.expiresAt ?? 0) <= Date.now()) return null;
		return cached.value;
	} catch {
		return null;
	}
}

function cacheStockForm(userId: string, value: SupplyStockForm): void {
	if (!userId) return;
	try {
		localStorage.setItem(supplyAccessCacheKey(userId), JSON.stringify({
			expiresAt: Date.now() + 12 * 60 * 60 * 1000,
			value,
		}));
	} catch {
		// В некоторых iframe localStorage закрыт; текущая сессия продолжит работать без кеша.
	}
}

type UseSupplyAccessStateOptions = {
	mock: boolean;
	requestId: number;
	transferDeepLinkId: number;
	dealSupplyId: number;
	linkTarget: string;
	defaultSuppliers: string[];
	setOrders: Dispatch<SetStateAction<SupplyOrderRow[]>>;
	setView: Dispatch<SetStateAction<SupplyViewKey>>;
};

type SupplyAccessState = {
	phase: SupplyPhase;
	ordersError: string | null;
	setOrdersError: Dispatch<SetStateAction<string | null>>;
	suppliers: string[];
	setSuppliers: Dispatch<SetStateAction<string[]>>;
	loading: boolean;
	currentUserId: string;
	canDeleteDocuments: boolean;
	marketplaceOnly: boolean;
	canOpenMarketplaces: boolean;
	stockForm: SupplyStockForm | null;
	setStockForm: Dispatch<SetStateAction<SupplyStockForm | null>>;
};

export function useSupplyAccessState({
	mock,
	requestId,
	transferDeepLinkId,
	dealSupplyId,
	linkTarget,
	defaultSuppliers,
	setOrders,
	setView,
}: UseSupplyAccessStateOptions): SupplyAccessState {
	const [phase, setPhase] = useState<SupplyPhase>('init');
	const [ordersError, setOrdersError] = useState<string | null>(null);
	const [suppliers, setSuppliers] = useState<string[]>(defaultSuppliers);
	const [loading, setLoading] = useState(!mock);
	const [currentUserId, setCurrentUserId] = useState('');
	const [canDeleteDocuments, setCanDeleteDocuments] = useState(mock);
	const [marketplaceOnly, setMarketplaceOnly] = useState(false);
	const [canOpenMarketplaces, setCanOpenMarketplaces] = useState(mock);
	const [stockForm, setStockForm] = useState<SupplyStockForm | null>(mock
			? { stores: ['Максидом Дунайский 64', 'Максидом Богатырский 15', 'Максидом ул. Фаворского 12'], suppliers: defaultSuppliers, canCreate: true, canEditSubmitted: true, isSupply: true }
		: null);

	useEffect(() => {
		if (mock) { setCurrentUserId('1858'); setPhase('ready'); return; }
		const bx = window.BX24;
		if (!bx) {
			setOrders(MOCK_ORDERS);
			setLoading(false);
			setPhase('ready');
			return;
		}
		bx.init(() => {
			void (async () => {
				const [uid, appAccess] = await Promise.all([
					withRetry(() => fetchCurrentUserId(), 3, 15000, 'user.current'),
					withTimeout(fetchCurrentAppAccess(), 20000, 'access-control/me').catch(() => null),
				]);
				const supplyDecision = appAccess?.decisions['supply.view'] ?? 'inherit';
				const marketplaceDecision = appAccess?.decisions['marketplaces.view'] ?? 'inherit';
				const directMarketplaceAccess = hasDirectMarketplaceAccess(uid);
				let access: SupplyStockForm | null = null;
				let accessUnavailable = false;
				if (supplyDecision !== 'deny') {
					try {
						access = await withRetry(() => fetchStockFormData(), 3, 15000, 'stock.form-data');
						cacheStockForm(uid, access);
					} catch {
						access = readCachedStockForm(uid);
						accessUnavailable = !access;
					}
				}
				setCurrentUserId(uid);
				if (access) setStockForm(access);
				const deleteDecision = appAccess?.decisions['supply.delete_documents'] ?? 'inherit';
				setCanDeleteDocuments(deleteDecision === 'allow' || (deleteDecision === 'inherit' && uid === '1858'));
				const hasSmartLink = requestId > 0 || transferDeepLinkId > 0 || dealSupplyId > 0;
				const managerLink = hasSmartLink && (linkTarget === 'manager' || (linkTarget !== 'supply' && !access?.isSupply));
				if (managerLink) {
					setLoading(false);
					setPhase('manager-link');
					return;
				}
				const canOpenSupply = supplyDecision === 'allow' || (supplyDecision === 'inherit' && Boolean(access?.canCreate));
				const canOpenMarketplace = directMarketplaceAccess || marketplaceDecision === 'allow'
					|| (marketplaceDecision === 'inherit' && canOpenSupply);
				setCanOpenMarketplaces(canOpenMarketplace);
				if (accessUnavailable && !canOpenSupply && !canOpenMarketplace) {
					setLoading(false);
					setPhase('unavailable');
					return;
				}
				if (!canOpenSupply && !canOpenMarketplace) { setLoading(false); setPhase('denied'); return; }
				if (!canOpenSupply && canOpenMarketplace) {
					setMarketplaceOnly(true);
					setView('marketplaces');
					setLoading(false);
					setPhase('ready');
					return;
				}
				setMarketplaceOnly(false);
				setPhase('ready');
				try {
					const loaded = await fetchSupplyOrders();
					setOrders(loaded);
					setOrdersError(null);
					const supplierList = await fetchSupplySuppliers().catch(() => []);
					setSuppliers([...new Set([...supplierList, ...defaultSuppliers])].filter(Boolean));
				} catch (error) {
					setOrdersError(error instanceof Error ? error.message : 'Не удалось загрузить заявки снабжения.');
				} finally {
					setLoading(false);
				}
			})().catch(() => { setLoading(false); setPhase('unavailable'); });
		});
	}, [dealSupplyId, defaultSuppliers, linkTarget, mock, requestId, setOrders, setView, transferDeepLinkId]);

	return {
		phase,
		ordersError,
		setOrdersError,
		suppliers,
		setSuppliers,
		loading,
		currentUserId,
		canDeleteDocuments,
		marketplaceOnly,
		canOpenMarketplaces,
		stockForm,
		setStockForm,
	};
}
