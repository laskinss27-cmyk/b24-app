const STORAGE_KEY = 'b24-dark-theme-v1';
let initialized = false;

function applyDarkTheme(enabled: boolean): void {
	document.documentElement.setAttribute('data-theme', enabled ? 'dark' : 'light');
}

export function initializeDarkTheme(): void {
	let enabled = false;
	try {
		enabled = window.localStorage.getItem(STORAGE_KEY) === 'on';
	} catch {
		// Embedded browsers may block storage; switching still works for this page.
	}
	applyDarkTheme(enabled);
	if (!initialized) {
		initialized = true;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.repeat || !event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey || event.code !== 'KeyM') return;
			event.preventDefault();
			const next = document.documentElement.getAttribute('data-theme') !== 'dark';
			applyDarkTheme(next);
			try { window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off'); }
			catch { /* Keep the current page theme when storage is unavailable. */ }
		};
		const onStorage = (event: StorageEvent): void => {
			if (event.key === STORAGE_KEY) applyDarkTheme(event.newValue === 'on');
		};
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('storage', onStorage);
	}
	// Bitrix opens the app in a cross-origin iframe and initially leaves keyboard
	// focus on its own page. Focus our frame so the shortcut works on first open.
	if (window !== window.top) {
		requestAnimationFrame(() => {
			if (!document.hasFocus()) window.focus();
		});
	}
}
