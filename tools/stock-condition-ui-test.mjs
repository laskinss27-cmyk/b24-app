import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
const require=createRequire('C:/Users/LapTOP/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
try{
	const page=await browser.newPage({viewport:{width:1280,height:1000}});
	const errors=[];page.on('pageerror',e=>errors.push(e.message));
	await page.goto(process.env.STOCK_CONDITION_PREVIEW_URL??'http://127.0.0.1:5182/stock-condition-preview.html');
	await page.getByRole('button',{name:'Изменить состояние части остатка',exact:true}).click();
	await page.getByLabel('Количество',{exact:false}).fill('1');
	await page.getByRole('button',{name:'Применить',exact:true}).click();
	await page.getByRole('status').filter({hasText:'Сохранено: 1 шт.'}).waitFor();
	const rows=await page.locator('.stock-condition-panel tbody tr').allTextContents();
	if(!rows.some(r=>r.includes('Обычный')&&r.includes('9'))||!rows.some(r=>r.includes('Сток')&&r.includes('1')))throw Error(`Unexpected balances ${rows}`);
	await fs.mkdir('outputs/stock-conditions',{recursive:true});
	await page.screenshot({path:'outputs/stock-conditions/quantity-split.png',fullPage:true});
	await page.getByRole('button',{name:'Проверить выбор при продаже'}).click();
	const select=page.getByLabel('Состояние и склад: Монитор CTV-5110');
	await select.selectOption({label:'Сток — 1 шт. · Тестовый склад'});
	const options=await select.locator('option').allTextContents();
	if(!options.includes('Обычный — 9 шт. · Тестовый склад'))throw Error('Normal choice missing');
	await page.screenshot({path:'outputs/stock-conditions/sale-choice.png',fullPage:true});
	if(errors.length)throw Error(errors.join('\n'));
	console.log(JSON.stringify({passed:true,rows,options,errors}));
}finally{await browser.close();}
