import fs from 'node:fs/promises';
import {isExcludedKit} from './scope.mjs';
const batch=process.argv[2];
const p=JSON.parse(await fs.readFile(`catalog-audit-v2/progress/batch-${batch}-proposal.json`,'utf8'));
let attributes=0;
for(const r of p.reports){
 if(isExcludedKit(r.name)||r.stock<=0)throw new Error(`Out of scope ${r.itemCode}`);
 const c=JSON.parse(r.patch.b24_catalog_content);
 const labels=new Set();
 for(const a of c.attributes){
  if(a.type==='number'&&!Number.isFinite(a.numberValue))throw new Error(`Invalid number ${r.itemCode}:${a.key}`);
  if(a.type==='range'&&(!Number.isFinite(a.numberMin)||!Number.isFinite(a.numberMax)||a.numberMin>a.numberMax))throw new Error(`Invalid range ${r.itemCode}:${a.key}`);
  if(a.type==='boolean'&&typeof a.booleanValue!=='boolean')throw new Error(`Invalid boolean ${r.itemCode}:${a.key}`);
  if(!/[а-яё]/iu.test(a.label))throw new Error(`Non-Russian label ${r.itemCode}:${a.label}`);
  const label=a.label.trim().toLowerCase();
  if(labels.has(label))throw new Error(`Duplicate label ${r.itemCode}:${a.label}`);
  labels.add(label);attributes++;
 }
 if(!/[а-яё]/iu.test(c.summary))throw new Error(`Non-Russian summary ${r.itemCode}`);
}
console.log(JSON.stringify({batch,cards:p.reports.length,attributes,valid:true}));
