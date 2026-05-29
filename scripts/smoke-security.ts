/**
 * Smoke-тест security-фиксов. Поднимает app через fastify.inject (без портов),
 * проверяет что гейты реально срабатывают. Ничего не пишет, в git не нужен.
 *
 * Запуск: npx tsx scripts/smoke-security.ts  (фронт должен быть собран — нужен dist/index.html)
 */
import 'dotenv/config';
import { buildApp } from '../packages/backend/src/app.js';
import { loadConfig } from '../packages/backend/src/config.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (obj: Record<string, string>): string => new URLSearchParams(obj).toString();

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		console.log(`  ❌ ${name}  ${detail}`);
	}
}

async function main(): Promise<void> {
const config = loadConfig();
const app = await buildApp({ config });

console.log('\n=== 1. /health + security-заголовки ===');
const h = await app.inject({ method: 'GET', url: '/health' });
assert('health 200', h.statusCode === 200, `got ${h.statusCode}`);
assert('CSP frame-ancestors задан', /frame-ancestors/.test(String(h.headers['content-security-policy'])), String(h.headers['content-security-policy']));
assert('X-Content-Type-Options: nosniff', h.headers['x-content-type-options'] === 'nosniff');
assert('Referrer-Policy задан', Boolean(h.headers['referrer-policy']));

console.log('\n=== 2. domain allowlist (SSRF/спуфинг) ===');
const forgedPlacement = await app.inject({
	method: 'POST', url: '/placement/deal-tab', headers: FORM,
	payload: form({ DOMAIN: 'evil.attacker.com', member_id: 'x', PLACEMENT: 'CRM_DEAL_DETAIL_TAB', PLACEMENT_OPTIONS: JSON.stringify({ ID: 32592 }) }),
});
assert('placement с чужим DOMAIN → 403', forgedPlacement.statusCode === 403, `got ${forgedPlacement.statusCode}`);

const forgedInstall = await app.inject({
	method: 'POST', url: '/install', headers: FORM,
	payload: form({ DOMAIN: 'evil.attacker.com', AUTH_ID: 'stolen', member_id: 'x' }),
});
assert('install с чужим DOMAIN → 403', forgedInstall.statusCode === 403, `got ${forgedInstall.statusCode}`);

const forgedHandler = await app.inject({
	method: 'POST', url: '/app/handler', headers: FORM,
	payload: form({ DOMAIN: 'evil.attacker.com', AUTH_ID: 'stolen' }),
});
assert('app/handler с чужим DOMAIN → 403', forgedHandler.statusCode === 403, `got ${forgedHandler.statusCode}`);

console.log('\n=== 3. легитимный DOMAIN проходит гейт ===');
const legit = await app.inject({
	method: 'POST', url: '/placement/deal-tab', headers: FORM,
	payload: form({ DOMAIN: config.portalDomain, member_id: 'x', PLACEMENT: 'CRM_DEAL_DETAIL_TAB', PLACEMENT_OPTIONS: JSON.stringify({ ID: 32592 }) }),
});
assert('placement с нашим DOMAIN → НЕ 403', legit.statusCode !== 403, `got ${legit.statusCode} (200=рендер, 503=dist нет)`);

console.log('\n=== 4. XSS-экранирование инжекта контекста ===');
const xss = await app.inject({
	method: 'POST', url: '/placement/deal-tab', headers: FORM,
	payload: form({ DOMAIN: config.portalDomain, member_id: '</script><script>alert(1)</script>', PLACEMENT: 'X', PLACEMENT_OPTIONS: '{}' }),
});
if (xss.statusCode === 200) {
	const raw = xss.body.includes('</script><script>alert(1)');
	const escaped = xss.body.includes('\\u003c/script');
	assert('сырой </script> НЕ попал в HTML', !raw);
	assert('payload экранирован как \\u003c', escaped);
} else {
	console.log(`  ⚠️ placement вернул ${xss.statusCode} (нет dist/index.html?) — путь экранирования не проверен`);
}

console.log('\n=== 5. /admin/bind-placement удалён ===');
const admin = await app.inject({ method: 'GET', url: '/admin/bind-placement' });
assert('admin endpoint → 404', admin.statusCode === 404, `got ${admin.statusCode}`);

await app.close();
console.log(`\n=== ИТОГ: ${pass} ✅ / ${fail} ❌ ===`);
process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
