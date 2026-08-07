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

export const requestB24FitWindow = (delay = 120): void => {
	window.setTimeout(() => {
		try {
			const bx24 = window.BX24;
			if (!bx24) return;
			bx24.resizeWindow(document.documentElement.clientWidth, dealContentHeight());
		} catch { /* outside placement context */ }
	}, delay);
};
