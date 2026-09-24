import fs from 'node:fs/promises';
import {isExcludedKit} from './scope.mjs';
export const notePattern = /(?<![а-яё])уточн|свер(?:ить|к[аиу]|ять)|провер(?:ить|ять|к[аиу].*(?:ревизи|маркиров|постав|экземпляр|модел))|требу(?:ет|ют|ется|ются).*(?:провер|паспорт|подтверж|идентиф)|не\s+(?:подтверж|установлен|определ[её]н|указан|извест|найден)|неизвест|исходник|исходн(?:ая|ой|ые|ым|ому|ого|ом|ых|ое)\s+(?:карточ|описан|данн|источник|назван|наименов|параметр|текст)|(?:складск|уч[её]тн).*(?:назван|наименов|карточ|исход)|прежн(?:ие|ее|яя|ей|ем)|противореч|разн(?:ым|ых) источник|источник(?:и|ов)?\s*(?::|—)|по источник|архивн.*(?:паспорт|страниц|источник)|(?:из|в)\s+(?:старой|прежней)\s+карточк|не\s+(?:перенес|перенес[её]н|добавлен|подменен|подмен[её]н|объявлен|превращен|превращ[её]н)|(?:данные|параметры)\s+сохранен|(?:исправлен|переведен|перевед[её]н|удал[её]н|отдел[её]н).*(?:единиц|характеристик|назван|заголов|исход|дубл|кг|массы|услуг)|не путать|по ревизии|ориентация измерения|по паспорту семейства|паспорт.*для выявления/iu;
export const noteLabel = /уточнен|уточнён|уточнения|замечани|ограничения и|источник (?:параметров|данных)|по исход|по источник|и ревизи|требует|требуют|по данным карточки|проверка данных|(?:версия|редакция) источника|расхождение с|неустановленные параметры|соответствие описания|аналитика и ограничения/iu;
export const uncertain = /радиоуправление из принадлежности|не кабельная продукция|не является кабельной продукцией|Диапазон измерений зависит от сенсора|исходной рекомендации|точная модель отсутств|нужен полный артикул|Не применяется к аналоговому|Общие сведения о других|необходим паспорт фактического|ошибочно|исходн(?:ым|ых|ой)\s+(?:сведен|характеристик|комплект)|не следует (?:смешивать|считать)|(?:необходимо|нужно) подтвердить|следует различать|по маркировке в каталоге|в этой карточке|эти сведения сохранены|(?:не|без) подтвержд|точные пределы зависят|предполож|требу(?:ется|ются|ет|ют)\s+маркиров|не проверен|исходной записи|исходной таблиц|(?:по|для|из|в)\s+(?:названию|наименованию|карточки|карточке)(?![а-яё])|по названию карточки|по наименованию этой карточки|для карточки|в уч[её]тном исполнении|ранни[ех].*(?:выпуск|редакци|текст)|редакци[ияю]|проверя(?:ют|ет)ся|проверки выпуска|(?:ревизии|версии).{0,50}(?:схем|инструкц)|(?:согласовать|схему|инструкции|схеме).{0,50}ревизи|конкретн.{0,60}(?:аппаратной версии|по маркировке)|не применяются|не обещано|расхождени|в старом.*каталоге|по найденному паспорту|в паспорте исполнения|параметры версии .*без маркировки|в наименовании каталога осталось|исходное .*повреждено|не мощность коммутируемой|не тождествен|изготовитель складского/iu;
export const extraNotes = /Битрикс24|исходн(?:ой|ая|ую|ые|ых|ое|ому|ом)\s+(?:таблиц|спецификац|постав|позиц)|по карточке|из карточки|(?![а-яё])в паспорте(?![а-яё])|(?:завис|различ|отлич|ограничен).{0,65}(?:ревизи|редакци)|(?:ревизи|редакци).{0,60}(?:различ|отлич)|не предполага|не является (?:разрешением|степенью)|не разрешение|габариты не|по раннему паспорту|точный .*по схеме|с проверкой модели|проверяется отдельно|не припис|не заявлен|не заявля|не доказы|не гарант|не обоснов|исходные\s+[«"\d]|исправлены|переведены|удалены|не подмен|не добавля|не идентифи|не определ|данных нет|нет данных|недостаточно данных|не подтверж|не удалось|нет достоверн|по памяти|(?<!не)установить по|служебн|нужн[аоы]?\s+(?:маркиров|паспорт|фото|точн|идентиф)/iu;
export const plain = value => String(value??'').replace(/<[^>]*>/gu,' ').replace(/\s+/gu,' ').trim();
export function cleanSummary(value){
 const sentences=String(value??'').split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/u);
 return sentences.filter(sentence=>!notePattern.test(sentence)&&!extraNotes.test(sentence)&&!uncertain.test(sentence)).join(' ').trim();
}
export function cleanContent(content){
 if(!content)return null;
 return {...content,summary:cleanSummary(content.summary),attributes:content.attributes.filter(a=>!noteLabel.test(a.label)&&!notePattern.test(`${a.label} ${a.rawValue} ${a.normalizedValue??''}`)&&!extraNotes.test(`${a.label} ${a.rawValue}`)&&!uncertain.test(`${a.label} ${a.rawValue}`))};
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/cleanup-notes.mjs')){
 const directory=process.env.B24_CLEANUP_DIR??'outputs/catalog-cleanup-2026-09-07';
 const snapshot=JSON.parse(await fs.readFile(`${directory}/snapshot-before.json`,'utf8'));
 const excluded=new Set(JSON.parse(await fs.readFile('catalog-audit-v2/progress/final-verification.json','utf8')).needsIdentification.map(x=>x.id));
 const scope=snapshot.items.filter(i=>!isExcludedKit(i.name)&&!excluded.has(i.id));
 const candidates=[];
 for(const item of scope){
  const after=cleanContent(item.content);
  const removed=(item.content?.attributes??[]).filter(a=>!after.attributes.includes(a));
  const descriptionFlagged=notePattern.test(item.description)||extraNotes.test(item.description)||uncertain.test(item.description);
  if(!removed.length&&after?.summary===item.content?.summary&&!descriptionFlagged)continue;
  candidates.push({id:item.id,name:item.name,stock:item.stockActual,modified:item.modified,beforeContent:item.content,afterContent:after,summaryBefore:item.summaryText,summaryAfter:after?.summary??'',removed,descriptionFlagged,descriptionBefore:item.description});
 }
 const result={generatedAt:new Date().toISOString(),snapshotAt:snapshot.generatedAt,scope:scope.length,excludedKits:snapshot.items.filter(i=>isExcludedKit(i.name)).length,excludedPersonal:excluded.size,candidates};
 await fs.writeFile(`${directory}/proposal.json`,JSON.stringify(result,null,2));
 await fs.writeFile(`${directory}/removed-attributes.txt`,candidates.flatMap(c=>c.removed.map(a=>`${c.id}\t${a.label}\t${a.rawValue}`)).join('\n'));
 await fs.writeFile(`${directory}/summary-review.txt`,candidates.filter(c=>c.summaryBefore!==c.summaryAfter).map(c=>`${c.id} ${c.name}\nBEFORE: ${c.summaryBefore}\nAFTER: ${c.summaryAfter}\n`).join('\n'));
 const remaining=scope.flatMap(i=>(cleanContent(i.content)?.attributes??[]).map(a=>({...a,id:i.id}))).filter(a=>/источник|ревизи|карточк|паспорт|свер|провер|сохран|данн|исправ|вариант|предполож|заявлен|вместо|не примен|не использ|не добав|редакци|маркировк|не указан|архив/iu.test(a.label+' '+a.rawValue));
 await fs.writeFile(`${directory}/remaining-review.txt`,remaining.map(a=>`${a.id}\t${a.label}\t${a.rawValue}`).join('\n'));
 console.log(JSON.stringify({scope:scope.length,candidates:candidates.length,removedAttributes:candidates.reduce((s,c)=>s+c.removed.length,0),summaries:candidates.filter(c=>c.summaryBefore!==c.summaryAfter).length,remainingReview:remaining.length}));
}
