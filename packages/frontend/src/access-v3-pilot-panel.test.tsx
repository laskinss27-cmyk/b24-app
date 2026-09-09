import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccessV3PilotPanel, requestPilot } from './AccessV3PilotPanel.js';

test('demo cannot activate real permissions',()=>{
	const html=renderToStaticMarkup(<AccessV3PilotPanel mock dirty={false} savedRevision={1}/>);
	assert.match(html,/В демо включение рабочих прав недоступно/);assert.doesNotMatch(html,/Подтверждаю: включить/);
});
test('publication client sends preview-bound input and rejects server failures',async t=>{
	const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
	Object.defineProperty(globalThis,'window',{configurable:true,value:{BX24:{getAuth:()=>({domain:'test.example',access_token:'test-only'})}}});
	t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
	let result={ok:true};let captured:Record<string,unknown>={};
	t.mock.method(globalThis,'fetch',async (url:unknown,init:RequestInit)=>{assert.equal(url,'/api/access-control/v3/pilot/activate');captured=JSON.parse(String(init.body));return new Response(JSON.stringify(result));});
	await requestPilot('activate',{draftRevision:1,pilotRevision:0,previewToken:'preview'});
	assert.deepEqual(captured,{domain:'test.example',accessToken:'test-only',draftRevision:1,pilotRevision:0,previewToken:'preview'});
	result={ok:false};await assert.rejects(requestPilot('activate'));
});
