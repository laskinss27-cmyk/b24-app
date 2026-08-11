export const PRODUCT_PICKER_MIN_HEIGHT = 900;

export const dealContentHeight = (minHeight = 0): number => {
	const root = document.getElementById('root');
	return Math.ceil(Math.max(
		minHeight,
		root?.scrollHeight ?? 0,
		document.body.scrollHeight,
		document.documentElement.scrollHeight,
	));
};

const dealFrameHeight = (): number => {
	const root = document.getElementById('root');
	if (!root?.classList.contains('deal-placement-root')) return dealContentHeight();
	return Math.ceil(Math.max(root.clientHeight, document.documentElement.clientHeight, window.innerHeight));
};

export const requestB24FitWindow = (delay = 120): void => {
	window.setTimeout(() => {
		try {
			const bx24 = window.BX24;
			if (!bx24) return;
		bx24.resizeWindow(document.documentElement.clientWidth, dealFrameHeight());
		} catch { /* outside placement context */ }
	}, delay);
};
