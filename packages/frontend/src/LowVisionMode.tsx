import { useState } from 'react';

const STORAGE_KEY = 'b24-low-vision-mode-v1';
const ROOT_CLASS = 'low-vision-mode';

function applyLowVisionMode(enabled: boolean): void {
	document.documentElement.classList.toggle(ROOT_CLASS, enabled);
	document.documentElement.setAttribute('data-low-vision', enabled ? 'on' : 'off');
}

export function initializeLowVisionMode(): boolean {
	let enabled = false;
	try {
		enabled = window.localStorage.getItem(STORAGE_KEY) === 'on';
	} catch {
		// The mode still works for the current page when browser storage is unavailable.
	}
	applyLowVisionMode(enabled);
	return enabled;
}

export function LowVisionMode({ initialEnabled }: { initialEnabled: boolean }): JSX.Element {
	const [enabled, setEnabled] = useState(initialEnabled);

	const toggle = (): void => {
		const next = !enabled;
		setEnabled(next);
		applyLowVisionMode(next);
		try {
			window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
		} catch {
			// Storage can be blocked inside an iframe; the current page still switches.
		}
	};

	return (
		<div className="low-vision-toolbar">
			<button
				type="button"
				className={`low-vision-toggle${enabled ? ' active' : ''}`}
				aria-pressed={enabled}
				aria-label={enabled ? 'Выключить режим для слабовидящих' : 'Включить режим для слабовидящих'}
				title={enabled ? 'Вернуть обычный размер интерфейса' : 'Увеличить текст, кнопки и контраст'}
				onClick={toggle}
			>
				<span className="low-vision-toggle-aa" aria-hidden="true">АА</span>
				<span>{enabled ? 'Обычный вид' : 'Крупный вид'}</span>
			</button>
		</div>
	);
}
