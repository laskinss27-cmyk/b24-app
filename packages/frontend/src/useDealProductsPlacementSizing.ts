import { useEffect, useRef } from 'react';
import type { DealProductPickerRequest, DealProductReplacement } from './DealProductsPicker.js';
import {
	PRODUCT_PICKER_MIN_HEIGHT,
	dealContentHeight,
	requestB24FitWindow,
} from './deal-products-placement-sizing.js';

export function useDealProductsPlacementFrame({
	mock,
	adding,
	replacing,
}: {
	mock: boolean | undefined;
	adding: DealProductPickerRequest | null;
	replacing: DealProductReplacement | null;
}): void {
	const initialFrameHeight = useRef(Math.ceil(Math.max(document.documentElement.clientHeight, window.innerHeight)));

	useEffect(() => {
		const root = document.getElementById('root');
		root?.classList.add('deal-placement-root');
		if (!mock) {
			document.documentElement.classList.add('deal-placement-html');
			document.body.classList.add('deal-placement-body');
		}
		requestB24FitWindow(80);
		return () => {
			root?.classList.remove('deal-placement-root');
			document.documentElement.classList.remove('deal-placement-html');
			document.body.classList.remove('deal-placement-body');
		};
	}, [mock]);

	useEffect(() => {
		if (mock || !window.BX24 || typeof ResizeObserver === 'undefined') return;
		const root = document.getElementById('root');
		if (!root) return;
		let timer: number | null = null;
		let lastHeight = 0;
		const syncHeight = (): void => {
			if (timer != null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				const height = adding
					? dealContentHeight(PRODUCT_PICKER_MIN_HEIGHT)
					: initialFrameHeight.current;
				if (height <= 0 || Math.abs(height - lastHeight) < 2) return;
				lastHeight = height;
				try { window.BX24?.resizeWindow(document.documentElement.clientWidth, height); } catch { /* placement closed */ }
			}, 80);
		};
		const observer = new ResizeObserver(syncHeight);
		observer.observe(root);
		window.addEventListener('resize', syncHeight);
		syncHeight();
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', syncHeight);
			if (timer != null) window.clearTimeout(timer);
		};
	}, [adding, replacing, mock]);
}

export function useDealProductsLoadedPlacementFit({
	mock,
	phase,
}: {
	mock: boolean | undefined;
	phase: 'init' | 'loading' | 'error' | 'ready';
}): void {
	// Два отложенных замера после загрузки страхуют вкладку от поздних шрифтов и стилей.
	// Последующие изменения содержимого ловит ограниченный по фактической высоте observer выше.
	useEffect(() => {
		if (mock || phase === 'init' || phase === 'loading') return;
		requestB24FitWindow(80);
		requestB24FitWindow(360);
	}, [mock, phase]);
}
