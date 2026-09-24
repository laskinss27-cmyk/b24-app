import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import decisions from './review-decisions.mjs';
import {isExcludedKit} from './scope.mjs';
const input='catalog-audit-v2/progress/stock-completeness-latest.json';
const audit=JSON.parse(await fs.readFile(input,'utf8'));
let priorReviews=[];
try{priorReviews=JSON.parse(await fs.readFile('catalog-audit-v2/progress/reviews.json','utf8')).reviews;}catch(e){if(e.code!=='ENOENT')throw e;}
for(const review of priorReviews){
 const i=audit.items.find(x=>x.id===review.id);
 if(!i||review.reviewedContentHash!==createHash('sha256').update(JSON.stringify([i.visibleSummary,i.content])).digest('hex'))throw new Error(`Previously reviewed content changed; explicit re-review required: ${review.id}`);
}
if(new Set(decisions.map(x=>x[0])).size!==decisions.length)throw new Error('Duplicate review');
const reviews=decisions.map(([id,status,reason])=>{
 const i=audit.items.find(x=>x.id===id);
 if(!i||isExcludedKit(i.name)||i.stockActual<=0)throw new Error(`Invalid review scope ${id}`);
 if(!['adequate_for_identity','needs_identification'].includes(status))throw new Error('Invalid status');
 return {id,name:i.name,status,reason,inventoryAt:audit.generatedAt,reviewedContentHash:createHash('sha256').update(JSON.stringify([i.visibleSummary,i.content])).digest('hex'),summary:i.visibleSummary,attributes:i.content.attributes,sources:[`${input}#${id}`]};
});
await fs.writeFile('catalog-audit-v2/progress/reviews.json',JSON.stringify({generatedAt:new Date().toISOString(),reviews},null,2)+'\n');
console.log(JSON.stringify({reviewed:reviews.length,needsIdentification:reviews.filter(x=>x.status==='needs_identification').length}));
