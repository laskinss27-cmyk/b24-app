/** Минимальный тест undici ProxyAgent против локального прокси. */
import { fetch as uf, ProxyAgent, setGlobalDispatcher } from 'undici';

(async () => {
	const pa = new ProxyAgent('http://127.0.0.1:10809');
	try {
		const r = await uf('https://umniydom.bitrix24.ru/', { dispatcher: pa, redirect: 'manual' });
		console.log('via dispatcher option:', r.status);
	} catch (e) {
		console.log('dispatcher option FAIL:', String((e as Error).cause ?? e).slice(0, 200));
	}
	try {
		setGlobalDispatcher(pa);
		const r2 = await uf('https://umniydom.bitrix24.ru/', { redirect: 'manual' });
		console.log('via global dispatcher:', r2.status);
	} catch (e) {
		console.log('global dispatcher FAIL:', String((e as Error).cause ?? e).slice(0, 200));
	}
})();
