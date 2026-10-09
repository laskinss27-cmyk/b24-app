import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTelegramConfig } from './config.js';
test('Telegram config remains optional and accepts only a complete server-side tuple', t => {
 const dir=mkdtempSync(join(tmpdir(),'telegram-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 assert.equal(readTelegramConfig(dir,{}),null);mkdirSync(join(dir,'telegram'));
 const config={apiId:12345,apiHash:'a'.repeat(32),key:'b'.repeat(64)};
 writeFileSync(join(dir,'telegram','config.json'),JSON.stringify(config),{mode:0o600});assert.deepEqual(readTelegramConfig(dir,{}),config);
 assert.throws(()=>readTelegramConfig(dir,{TELEGRAM_API_ID:'12345'}),/ключ хранения/);
 assert.deepEqual(readTelegramConfig(dir,{TELEGRAM_API_ID:'999',TELEGRAM_API_HASH:'c'.repeat(32),TELEGRAM_SESSION_KEY:'d'.repeat(64)}),{apiId:999,apiHash:'c'.repeat(32),key:'d'.repeat(64)});
});
test('Malformed Telegram configuration fails closed without disclosing file contents',t=>{
 const dir=mkdtempSync(join(tmpdir(),'telegram-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(join(dir,'telegram'));
 writeFileSync(join(dir,'telegram','config.json'),'private-secret');assert.throws(()=>readTelegramConfig(dir,{}),e=>e instanceof Error&&!e.message.includes('private-secret'));
 for(const value of [null,[],{apiId:1,apiHash:'bad',key:'secret'}]){writeFileSync(join(dir,'telegram','config.json'),JSON.stringify(value));assert.throws(()=>readTelegramConfig(dir,{}),/API-параметры/);}
});
test('Optional Telegram SOCKS5 settings are server-only, validated and do not mix with environment credentials',t=>{
 const dir=mkdtempSync(join(tmpdir(),'telegram-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(join(dir,'telegram'));
 const file=join(dir,'telegram','config.json'),config={apiId:12345,apiHash:'a'.repeat(32),key:'b'.repeat(64)},proxy={ip:'telegram-egress',port:1080,socksType:5,username:'worker',password:'test-password'};
 writeFileSync(file,JSON.stringify({...config,proxy}));assert.deepEqual(readTelegramConfig(dir,{}),{...config,proxy});
 const env={TELEGRAM_API_ID:'12345',TELEGRAM_API_HASH:config.apiHash,TELEGRAM_SESSION_KEY:config.key};assert.equal(readTelegramConfig(dir,env)?.proxy,undefined);
 for(const bad of [{...proxy,port:0},{...proxy,port:70000},{...proxy,ip:'http://proxy/'},{...proxy,socksType:4},{...proxy,extra:'unexpected'}]){writeFileSync(file,JSON.stringify({...config,proxy:bad}));assert.throws(()=>readTelegramConfig(dir,{}),/SOCKS5/);}
});
