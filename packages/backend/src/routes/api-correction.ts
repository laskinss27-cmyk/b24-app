import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { seal, unseal, safeEqual } from '../mobile-session.js';
import { ErpClient } from '../erp/client.js';
import { searchErpItems, itemStockAllStores, listActiveStoreTitles, createStockCorrection } from '../erp/operations.js';

/**
 * ЛИЧНЫЙ инструмент коррекции остатков (только Сергей). Открывается по ссылке /correction
 * с любого устройства, ОТДЕЛЬНАЯ учётка (не связана с Б24/компанийскими аккаунтами):
 * логин/пароль из env (CORRECTION_USER + CORRECTION_PW_SHA256), сессия — подписанный токен (seal).
 * «Применить» = тихий Stock Reconciliation на ОДНУ позицию в ядре (документ-история).
 * Правки в ядро под отдельным токеном (CORRECTION_ERP_TOKEN) — аудит, иначе общий ERPNEXT_TOKEN.
 *
 * ВЫКЛЮЧЕН, пока в env нет CORRECTION_USER/CORRECTION_PW_SHA256 (все эндпоинты 503).
 * NB: пока синк Б24→ядро жив, правка затрётся ближайшим синком — инструмент «живой» только
 * когда ядро = источник правды (см. project_stock_correction_tool). Строим впрок.
 */
const TTL_SEC = 8 * 3600;

function errInfo(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function registerApiCorrectionRoute(app: FastifyInstance): void {
	const user = app.config.correctionUser;
	const pwHash = app.config.correctionPwSha256;
	const enabled = (): boolean => Boolean(user && pwHash);
	const secret = (): string => app.config.correctionSecret || app.config.appSecret || '';

	const corrErp = (): ErpClient | null => {
		const url = process.env['ERPNEXT_URL'];
		const tok = app.config.correctionErpToken || process.env['ERPNEXT_TOKEN'];
		if (!url || !tok) return null;
		return new ErpClient({ url: url.replace(/\/$/, ''), token: tok });
	};

	const authed = (req: FastifyRequest): boolean => {
		const hdr = req.headers['x-correction-token'];
		const tok = (typeof hdr === 'string' ? hdr : undefined) ?? (req.body as { token?: string } | undefined)?.token;
		const p = unseal(secret(), tok, Math.floor(Date.now() / 1000));
		return Boolean(p && p['sub'] === 'correction');
	};

	// ── Вход: отдельная учётка → сессионный токен ─────────────────────────────
	app.post('/api/correction/login', async (req, reply) => {
		if (!enabled() || !secret()) return reply.code(503).send({ ok: false, error: 'инструмент выключен (нет учётки/секрета в env)' });
		const b = (req.body ?? {}) as { user?: unknown; password?: unknown };
		const inUser = String(b.user ?? '');
		const inHash = createHash('sha256').update(String(b.password ?? ''), 'utf8').digest('hex');
		const ok = safeEqual(inUser, String(user)) && safeEqual(inHash, String(pwHash).toLowerCase());
		if (!ok) return reply.code(401).send({ ok: false, error: 'неверные логин или пароль' });
		const token = seal(secret(), { sub: 'correction', exp: Math.floor(Date.now() / 1000) + TTL_SEC });
		app.log.info({}, '[correction] login ok');
		return { ok: true, token };
	});

	// ── Поиск товара (id / имя / артикул) ─────────────────────────────────────
	app.post('/api/correction/search', async (req, reply) => {
		if (!enabled()) return reply.code(503).send({ ok: false, error: 'выключен' });
		if (!authed(req)) return reply.code(401).send({ ok: false, error: 'нужен вход' });
		const erp = corrErp();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const q = String((req.body as { q?: unknown } | undefined)?.q ?? '');
		try { return { ok: true, items: await searchErpItems(erp, q) }; }
		catch (e) { return reply.code(200).send({ ok: false, error: errInfo(e) }); }
	});

	// ── Остатки товара по складам + список складов для выбора ──────────────────
	app.post('/api/correction/stock', async (req, reply) => {
		if (!enabled()) return reply.code(503).send({ ok: false, error: 'выключен' });
		if (!authed(req)) return reply.code(401).send({ ok: false, error: 'нужен вход' });
		const erp = corrErp();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const productId = Number((req.body as { productId?: unknown } | undefined)?.productId);
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'bad productId' });
		try {
			const [stocks, stores] = await Promise.all([itemStockAllStores(erp, productId), listActiveStoreTitles(erp)]);
			return { ok: true, stocks, stores };
		} catch (e) { return reply.code(200).send({ ok: false, error: errInfo(e) }); }
	});

	// ── Применить коррекцию: Stock Reconciliation на 1 позицию ─────────────────
	app.post('/api/correction/apply', async (req, reply) => {
		if (!enabled()) return reply.code(503).send({ ok: false, error: 'выключен' });
		if (!authed(req)) return reply.code(401).send({ ok: false, error: 'нужен вход' });
		const erp = corrErp();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const b = (req.body ?? {}) as { productId?: unknown; storeTitle?: unknown; newQty?: unknown };
		const productId = Number(b.productId);
		const storeTitle = String(b.storeTitle ?? '').trim();
		const newQty = Number(b.newQty);
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'bad productId' });
		if (!storeTitle) return reply.code(400).send({ ok: false, error: 'не выбран склад' });
		if (!Number.isFinite(newQty) || newQty < 0) return reply.code(400).send({ ok: false, error: 'кол-во должно быть ≥ 0' });
		try {
			const { name } = await createStockCorrection(erp, { productId, storeTitle, newQty });
			app.log.info({ productId, storeTitle, newQty, doc: name }, '[correction] applied');
			return { ok: true, doc: name, productId, storeTitle, newQty };
		} catch (e) { return reply.code(200).send({ ok: false, error: errInfo(e) }); }
	});

	// ── Страница инструмента ──────────────────────────────────────────────────
	app.get('/correction', async (_req, reply) => {
		reply.type('text/html; charset=utf-8').send(PAGE_HTML);
	});
}

const PAGE_HTML = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Коррекция остатков</title>
<style>
 :root{--b:#e3e8ef;--mut:#7a8699;--pri:#185fa5}
 *{box-sizing:border-box} body{font-family:system-ui,Arial,sans-serif;color:#1a2231;max-width:680px;margin:0 auto;padding:16px}
 h1{font-size:20px;margin:0 0 12px} input,select,button{font-size:16px;padding:9px 11px;border:1px solid var(--b);border-radius:9px;outline:none}
 button{background:var(--pri);color:#fff;border:0;cursor:pointer} button.ghost{background:#fff;color:#1a2231;border:1px solid var(--b)}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
 .card{border:1px solid var(--b);border-radius:12px;padding:12px;margin:8px 0}
 .res{cursor:pointer;padding:8px;border-bottom:1px solid #f0f2f5} .res:hover{background:#f6f8fb}
 .mut{color:var(--mut);font-size:13px} .err{color:#e5484d} .ok{color:#047857}
 table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:6px;border-bottom:1px solid #f0f2f5;text-align:left}
 .qin{width:90px;text-align:center} .hide{display:none}
</style></head><body>
<h1>🔧 Коррекция остатков</h1>

<div id="login" class="card">
 <div class="mut">Личный инструмент. Вход по отдельной учётке.</div>
 <div class="row"><input id="lu" placeholder="логин" autocomplete="username"></div>
 <div class="row"><input id="lp" type="password" placeholder="пароль" autocomplete="current-password"></div>
 <div class="row"><button id="lbtn">Войти</button> <span id="lmsg" class="err"></span></div>
</div>

<div id="app" class="hide">
 <div class="row"><input id="q" placeholder="поиск: id / название / артикул" style="flex:1"><button id="qbtn">Найти</button><button id="logout" class="ghost">Выход</button></div>
 <div id="msg" class="row"></div>
 <div id="results"></div>
 <div id="item" class="hide card"></div>
</div>

<script>
var TOK = localStorage.getItem('corr_token') || '';
function api(path, body){return fetch('/api/correction/'+path,{method:'POST',headers:{'Content-Type':'application/json','x-correction-token':TOK},body:JSON.stringify(body||{})}).then(function(r){return r.json().then(function(j){return {status:r.status,j:j}})})}
function show(el,on){document.getElementById(el).className = on ? document.getElementById(el).className.replace(' hide','') : (document.getElementById(el).className.indexOf('hide')<0?document.getElementById(el).className+' hide':document.getElementById(el).className)}
function msg(t,cls){var m=document.getElementById('msg');m.innerHTML='<span class="'+(cls||'mut')+'">'+t+'</span>'}
function logout(){TOK='';localStorage.removeItem('corr_token');document.getElementById('app').className='hide';document.getElementById('login').className='card'}

document.getElementById('lbtn').onclick=function(){
 var u=document.getElementById('lu').value, p=document.getElementById('lp').value;
 api('login',{user:u,password:p}).then(function(r){
  if(r.j&&r.j.ok){TOK=r.j.token;localStorage.setItem('corr_token',TOK);document.getElementById('login').className='card hide';document.getElementById('app').className='';document.getElementById('lmsg').textContent=''}
  else document.getElementById('lmsg').textContent=(r.j&&r.j.error)||'ошибка'
 })
};
document.getElementById('logout').onclick=logout;

function doSearch(){
 var q=document.getElementById('q').value.trim(); if(!q)return;
 msg('ищу…'); document.getElementById('item').className='hide card';
 api('search',{q:q}).then(function(r){
  if(r.status===401){logout();return}
  if(!r.j.ok){msg(r.j.error,'err');return}
  msg(r.j.items.length+' найдено');
  var h=''; r.j.items.forEach(function(it){h+='<div class="res" data-id="'+it.productId+'" data-name="'+(it.name||'').replace(/"/g,'&quot;')+'"><b>'+(it.name||('#'+it.productId))+'</b> <span class="mut">'+(it.article||'')+(it.brand?' · '+it.brand:'')+' · id '+it.productId+'</span></div>'});
  var R=document.getElementById('results'); R.innerHTML=h;
  Array.prototype.forEach.call(R.querySelectorAll('.res'),function(e){e.onclick=function(){openItem(+e.getAttribute('data-id'),e.getAttribute('data-name'))}})
 })
}
document.getElementById('qbtn').onclick=doSearch;
document.getElementById('q').addEventListener('keydown',function(e){if(e.key==='Enter')doSearch()});

function openItem(pid,name){
 var box=document.getElementById('item'); box.className='card'; box.innerHTML='<div class="mut">загрузка остатков…</div>';
 api('stock',{productId:pid}).then(function(r){
  if(r.status===401){logout();return}
  if(!r.j.ok){box.innerHTML='<span class="err">'+r.j.error+'</span>';return}
  var cur={}; r.j.stocks.forEach(function(s){cur[s.storeTitle]=s.qty});
  var rows=''; r.j.stores.forEach(function(st){
   var q=cur[st]!=null?cur[st]:0;
   rows+='<tr><td>'+st+'</td><td>'+q+'</td><td><input class="qin" type="number" min="0" step="any" value="'+q+'" data-store="'+st.replace(/"/g,'&quot;')+'"></td><td><button class="apply" data-store="'+st.replace(/"/g,'&quot;')+'">Применить</button></td></tr>'
  });
  box.innerHTML='<div class="row"><b>'+(name||('#'+pid))+'</b> <span class="mut">id '+pid+'</span></div><table><tr><th>Склад</th><th>Сейчас</th><th>Новое</th><th></th></tr>'+rows+'</table><div id="amsg" class="row"></div>';
  Array.prototype.forEach.call(box.querySelectorAll('.apply'),function(btn){btn.onclick=function(){
   var st=btn.getAttribute('data-store');
   var inp=box.querySelector('.qin[data-store="'+st.replace(/"/g,'\\\\"')+'"]');
   var nq=Number(inp.value);
   if(!isFinite(nq)||nq<0){document.getElementById('amsg').innerHTML='<span class="err">кол-во ≥ 0</span>';return}
   btn.disabled=true; document.getElementById('amsg').innerHTML='<span class="mut">применяю…</span>';
   api('apply',{productId:pid,storeTitle:st,newQty:nq}).then(function(r){
    btn.disabled=false;
    if(r.status===401){logout();return}
    if(r.j.ok)document.getElementById('amsg').innerHTML='<span class="ok">✅ '+st+' → '+nq+' (док '+r.j.doc+'). Перезагрузка остатков…</span>',setTimeout(function(){openItem(pid,name)},900);
    else document.getElementById('amsg').innerHTML='<span class="err">⛔ '+r.j.error+'</span>'
   })
  }})
 })
}

if(TOK){document.getElementById('login').className='card hide';document.getElementById('app').className=''}
</script>
</body></html>`;
