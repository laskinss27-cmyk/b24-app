// Local verification only. Never expose this launcher publicly or deploy it.
import 'dotenv/config';
import { config as readEnv } from 'dotenv';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { B24Client } from '../../packages/backend/src/b24/client.ts';
import { TelegramStore } from '../../packages/backend/src/integrations/telegram/store.ts';
import { TelegramService } from '../../packages/backend/src/integrations/telegram/service.ts';
import { telegramTransport } from '../../packages/backend/src/integrations/telegram/transport.ts';
import { registerTelegramRoutes } from '../../packages/backend/src/integrations/telegram/routes.ts';
readEnv({path:'.secrets/telegram-api.env'});
if(!process.env.TELEGRAM_SESSION_KEY){const key=randomBytes(32).toString('hex');appendFileSync('.secrets/telegram-api.env',`\nTELEGRAM_SESSION_KEY=${key}\n`,{mode:0o600});process.env.TELEGRAM_SESSION_KEY=key;}
const port=5200,origin=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex');
const webhook=process.env.DEV_WEBHOOK;
if(!webhook||new URL(webhook).hostname!=='umniydom.bitrix24.ru')throw new Error('Expected configured portal webhook');
const client=new B24Client({auth:{kind:'webhook',url:webhook}});
const store=new TelegramStore(resolve('.local/telegram/telegram.sqlite'),process.env.TELEGRAM_SESSION_KEY);
const service=new TelegramService(store,telegramTransport(Number(process.env.TELEGRAM_API_ID),process.env.TELEGRAM_API_HASH));
const app=Fastify({logger:false,bodyLimit:8192});
app.decorate('config',{portalDomain:'umniydom.bitrix24.ru',nodeEnv:'development'});
app.addHook('onRequest',async(req,reply)=>{
 reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"frame-ancestors 'none'");
 if(req.headers.host!==`127.0.0.1:${port}` || (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])))return reply.code(403).send({ok:false,error:'Откройте локальный экран напрямую'});
 if(req.url.startsWith('/api/')){
  const cookie=/(?:^|;\s*)telegram_local=([^;]+)/.exec(req.headers.cookie??'')?.[1]??'';
  const bytes=Buffer.from(cookie),expected=Buffer.from(token);
  if(bytes.length!==expected.length||!timingSafeEqual(bytes,expected)||req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json'))return reply.code(403).send({ok:false,error:'Обновите локальный экран'});
 }
});
await app.register(fastifyStatic,{root:resolve('packages/frontend/dist'),index:false});
app.get('/',async(_req,reply)=>{
 reply.header('Set-Cookie',`telegram_local=${token}; HttpOnly; SameSite=Strict; Path=/`);
 const ctx={view:'telegram',dealId:37974,domain:'umniydom.bitrix24.ru',memberId:null,accessToken:'local-only'};
 return reply.type('text/html; charset=utf-8').send(readFileSync('packages/frontend/dist/index.html','utf8').replace('</head>',`<script>window.__B24_CONTEXT__=${JSON.stringify(ctx)};</script></head>`));
});
registerTelegramRoutes(app,service,(_app,body)=>body.domain==='umniydom.bitrix24.ru'&&body.accessToken==='local-only'?client:null);
service.start();
await app.listen({port,host:'127.0.0.1'});
console.log(`Persistent Telegram verification: ${origin}`);
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();store.close();process.exit(0);};process.once('SIGTERM',stop);process.once('SIGINT',stop);