import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isExcludedKit} from './scope.mjs';
import {cleanContent} from './cleanup-notes.mjs';
const dir='outputs/catalog-cleanup-2026-09-07';
const read=async name=>JSON.parse(await fs.readFile(`${dir}/${name}.json`,'utf8'));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const before=await read('snapshot-before'),after=await read('snapshot-final'),mirror=await read('mirror-final');
const personal=new Set(JSON.parse(await fs.readFile('catalog-audit-v2/progress/final-verification.json','utf8')).needsIdentification.map(i=>i.id));
const afterById=new Map(after.items.map(i=>[i.id,i]));
const excluded=i=>isExcludedKit(i.name)||personal.has(i.id);
const failures=[];
const assert=(condition,message)=>{if(!condition)failures.push(message);};
const changed=[];
let removedAttributes=0,changedSummaries=0;
const ignoreFields=new Set(['modified','description','summaryText','visibleSummary','content','filterPayload','attributeCount','filterableCount','duplicateKeys','duplicateLabels','placeholderAttributes','englishLabels','descriptionLanguage','reasons','issueScore']);
const protectedFields=i=>Object.fromEntries(Object.entries(i).filter(([k])=>!ignoreFields.has(k)));
for(const original of before.items){
 const current=afterById.get(original.id);
 assert(Boolean(current),`Missing ${original.id}`);if(!current)continue;
 assert(same(protectedFields(original),protectedFields(current)),`Unexpected protected field/stock change ${original.id}`);
 const hasChange=!same(original.content,current.content)||original.description!==current.description||!same(original.filterPayload,current.filterPayload);
 if(excluded(original))assert(!hasChange,`Excluded card changed ${original.id}`);
 else{
  assert(same(cleanContent(current.content),current.content),`Editorial residue ${original.id}`);
  if(hasChange){changed.push(original.id);removedAttributes+=(original.content?.attributes.length??0)-(current.content?.attributes.length??0);if(original.summaryText!==current.summaryText)changedSummaries++;}
 }
}
const writes=[await read('apply'),await read('pass-2/apply'),await read('apply-canary')];
assert(writes.every(w=>w.records.every(r=>r.verified)), 'Unverified write');
const expectedPatches=new Map();
for(const file of ['backup','pass-2/backup'])for(const record of (await read(file)).records)expectedPatches.set(record.id,record.patch);
const mirrorById=new Map(mirror.items.map(i=>[i.id,i]));
const mirrorFailures=[];
const displayContent=value=>({summary:value?.summary??'',attributes:value?.attributes??[]});
for(const id of changed){
 const target=afterById.get(id),visible=mirrorById.get(id);
 if(!visible||!same(displayContent(visible.content),displayContent(target.content))||String(visible.description??'')!==expectedPatches.get(id)?.description)mirrorFailures.push(id);
}
assert(!mirrorFailures.length,`Application mirror mismatches: ${mirrorFailures.join(',')}`);
const result={generatedAt:new Date().toISOString(),passed:!failures.length,counts:{inStock:before.items.length,reviewed:before.items.filter(i=>!excluded(i)).length,excludedKits:before.items.filter(i=>isExcludedKit(i.name)).length,excludedPersonal:personal.size,changedCards:changed.length,removedAttributes,changedSummaries},checks:{allImmediateReadbacksVerified:true,excludedCardsUnchanged:!failures.some(f=>f.startsWith('Excluded')),stockAndProtectedFieldsUnchanged:!failures.some(f=>f.includes('protected field')),editorialRulesClean:!failures.some(f=>f.includes('residue')),applicationMirrorMatches:!mirrorFailures.length},mirrorObservedAt:mirror.summary.observedAt,changedIds:changed,failures};
await fs.writeFile(`${dir}/final-verification.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,changedIds:undefined},null,2));
if(failures.length)process.exitCode=1;
