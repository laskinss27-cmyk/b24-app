import {f,n} from './batch-001-cameras.mjs';
export {n};
export const num=(k,l,g,v,u='')=>f(k,l,g,'number',`${v}${u?' '+u:''}`,u);
export const opt=(k,l,g,v)=>f(k,l,g,'option',v);
export const bool=(k,l,g,v=true)=>f(k,l,g,'boolean',v?'Да':'Нет');
export const range=(k,l,g,v,u)=>f(k,l,g,'range',v,u);
export const kind=v=>opt('product_type','Тип устройства','Идентификация',v);
export const temp=v=>range('operating_temperature','Рабочая температура','Эксплуатация',v,'°C');
