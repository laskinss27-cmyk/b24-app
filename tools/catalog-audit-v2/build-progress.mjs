import fs from 'node:fs/promises';
import {isExcludedKit} from './scope.mjs';
import {createHash} from 'node:crypto';
const directory='catalog-audit-v2/progress';
const input=process.argv[2]||`${directory}/stock-completeness-latest.json`;
const audit=JSON.parse(await fs.readFile(input,'utf8'));
const files=(await fs.readdir(directory)).filter(x=>/^batch-\d+-applied\.json$/u.test(x)).sort();
const completed=[];
for(const file of files){
 const batch=JSON.parse(await fs.readFile(`${directory}/${file}`,'utf8'));
 if(batch.mode!=='apply'||batch.reports.some(row=>!row.verified))throw new Error(`Unverified batch ${file}`);
 completed.push(...batch.reports.map(row=>({id:row.itemCode,name:row.name,batch:batch.batch,attributes:row.attributes,protectedDescription:row.protectedDescription,sources:row.sources,unresolved:row.unresolved,verifiedAt:batch.generatedAt})));
}
if(new Set(completed.map(x=>x.id)).size!==completed.length)throw new Error('Repeated completed ID');
const done=new Set(completed.map(x=>x.id));
let reviewFile={reviews:[]};
try{reviewFile=JSON.parse(await fs.readFile(`${directory}/reviews.json`,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const acceptedReviews=reviewFile.reviews.filter(r=>{const i=audit.items.find(x=>x.id===r.id);return i&&!done.has(r.id)&&!isExcludedKit(i.name)&&r.reviewedContentHash===createHash('sha256').update(JSON.stringify([i.visibleSummary,i.content])).digest('hex');});
const reviewed=new Set(acceptedReviews.map(x=>x.id));
// Technical protocol names are valid in Russian product cards; prose headings are not.
const technicalLabel=/^(?:Wi[-‑]?Fi|Bluetooth(?:\s*\d(?:\.\d)?)?|Zigbee|Z[-‑]?Wave|Matter|PoE(?:\+|\+\+)?|ONVIF|NFC|RFID|WDR|DWDR|DNR|USB(?:\s*\d(?:\.\d)?)?|HDMI|VGA|BNC|RS[-‑]?485|RS[-‑]?232|TCP\/IP|IP|SATA|HDD|SSD|SD|microSD|PIR|PTZ|NVP|NVR|DVR|IR|IK|CCT|CRI|RGB|RGBW|LED|DIN|Ethernet|LAN|WAN|RJ[-‑]?45|RTSP|RTMP|MQTT|HTTP|HTTPS|SDK|API|BLE|CPU|RAM|ROM|SIM|eSIM|Modbus(?:\s+RTU)?|Z[-‑]?Wave Plus)$/iu;
const extraTechnical=/^(?:UID|VLAN|QoS|WPS|IPv[46]|VPN|ANR|ROI|NTP|P2P|RTSPS|SIP|DDNS|NAT|UPnP|Multi-WAN|Mesh Wi-Fi|PoE Watchdog|Motion Detection 2\.0|Smart Dual Light|Micro ?SD(?:HC|XC)?(?:\s*\/\s*SDHC\s*\/\s*SDXC)?)$/iu;
const english=(text)=>/[a-z]{3}/iu.test(text)&&!/[а-яё]/iu.test(text)&&!technicalLabel.test(text.trim())&&!extraTechnical.test(text.trim())&&!/^(?:Mesh|EAN|ONVIF\s+\d+(?:\.\d+)?|AI-PoE Watchdog|STP\/RSTP\/MSTP)$/iu.test(text.trim())&&!/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/u.test(text.trim());
const coreReasons=new Set(['missing_description','missing_structured_content','missing_attributes','missing_filter_category','missing_filter_payload','invalid_filter_payload','category_attribute_outlier','placeholder_attribute_values','duplicate_attribute_labels','no_filterable_attributes']);
const queue=[];const metadataOnly=[];const excludedKits=[];
for(const item of audit.items){
 if(isExcludedKit(item.name)){excludedKits.push({id:item.id,name:item.name,stock:item.stockActual,previouslyCorrected:done.has(item.id)});continue;}
 if(done.has(item.id))continue;
 if(reviewed.has(item.id))continue;
 const reasons=item.reasons.filter(r=>coreReasons.has(r));
 const englishLabels=(item.content?.attributes||[]).filter(a=>english(a.label)).map(a=>a.label);
 if(englishLabels.length)reasons.push('english_attribute_labels');
 const summary=item.visibleSummary.trim();
 if(summary&&/[a-z]{3}/iu.test(summary)&&!/[а-яё]/iu.test(summary)&&!technicalLabel.test(summary))reasons.push('non_russian_summary');
 if(item.reasons.includes('very_short_description'))reasons.push('short_summary_requires_review');
 const row={id:item.id,name:item.name,stock:item.stockActual,section:item.section,attributes:item.attributeCount,reasons:[...new Set(reasons)],englishLabels};
 if(row.reasons.length)queue.push(row);
 else if(item.reasons.some(r=>['missing_brand','missing_model','missing_section'].includes(r)))metadataOnly.push({...row,reasons:item.reasons.filter(r=>['missing_brand','missing_model','missing_section'].includes(r))});
}
queue.sort((a,b)=>Number(b.reasons.includes('non_russian_summary'))-Number(a.reasons.includes('non_russian_summary'))||Number(b.attributes===0)-Number(a.attributes===0)||b.stock-a.stock);
const inScopeCompleted=completed.filter(x=>!isExcludedKit(x.name));
const result={generatedAt:new Date().toISOString(),inventoryAt:audit.generatedAt,scope:'Enabled stock catalog items with sum(actual_qty)>0, excluding kits/sets per user clarification on 2026-09-06. Queue is automated screening, not proof of bad content. Complete cards and zero-stock cards are not rewritten.',counts:{inStock:audit.items.length,excludedKits:excludedKits.length,correctedAndVerified:completed.length,correctedInCurrentScope:inScopeCompleted.length,contentCandidatesRemaining:queue.length,metadataOnlyCandidates:metadataOnly.length,noAutomatedContentIssues:audit.items.length-excludedKits.length-inScopeCompleted.length-queue.length-metadataOnly.length},completed,queue,metadataOnly,excludedKits};
result.reviews=acceptedReviews;
result.counts.reviewedWithoutWrite=acceptedReviews.length;
result.counts.awaitingIdentification=acceptedReviews.filter(x=>x.status==='needs_identification').length;
result.counts.noAutomatedContentIssues-=acceptedReviews.length;
await fs.writeFile(`${directory}/progress.json`,JSON.stringify(result,null,2)+'\n','utf8');
console.log(JSON.stringify(result.counts,null,2));
