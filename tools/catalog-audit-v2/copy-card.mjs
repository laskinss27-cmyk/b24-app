import {n} from './fields.mjs';
// Changes are explicit and bounded; unknown labels fail closed.
export function copyCard(snapshots,beforePath,{id,category,summary,changes={},append=[],note,sources=[]}){
 const s=snapshots.find(x=>x.itemCode===id);if(!s)throw Error('Missing snapshot '+id);
 const c=JSON.parse(s.item.b24_catalog_content);
 for(const label of Object.keys(changes))if(!c.attributes.some(a=>a.label===label))throw Error(id+' missing '+label);
 const attributes=c.attributes.flatMap((a,i)=>{
  if(Object.hasOwn(changes,a.label)){
   const v=changes[a.label];if(v===null)return [];
   return [Array.isArray(v)?n('corrected_'+i,v[0],v[2]||a.group,v[1]):v];
  }
  return [{...a,id:'preserved_'+i,key:'preserved_'+i}];
 });
 attributes.push(...append);
 return {itemCode:id,category,summary:summary??c.summary,attributes,sources:[...sources,beforePath+'#'+id],unresolved:[note]};
}
