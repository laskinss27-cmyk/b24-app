import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
// Безопасный зонд: вызываем метод с пустыми params. METHOD_NOT_FOUND = метода нет.
// Любая другая ошибка (REQUIRED_ARG_MISSING / INVALID_ARG / ...) = метод СУЩЕСТВУЕТ (ничего не создано).
async function probe(m: string): Promise<void> {
  try { const r = await client.call(m, {}); console.log(`  ✅ ЕСТЬ  ${m.padEnd(34)} → вернул результат (без аргументов!) ${JSON.stringify(r).slice(0,80)}`); }
  catch (e) {
    if (e instanceof B24ApiError) {
      const ex = e.code === 'ERROR_METHOD_NOT_FOUND' || /METHOD_NOT_FOUND/i.test(e.code);
      console.log(`  ${ex?'⛔ НЕТ ':'✅ ЕСТЬ'}  ${m.padEnd(34)} → ${e.code}: ${(e.description??'').slice(0,70)}`);
    } else console.log(`  ?? ${m.padEnd(34)} → ${String(e).slice(0,70)}`);
  }
}
(async () => {
  console.log('=== ОСТАТКИ напрямую (storeproduct) ===');
  for (const m of ['catalog.storeproduct.list','catalog.storeproduct.add','catalog.storeproduct.update','catalog.storeproduct.set','catalog.storeproduct.fields','catalog.storeproduct.get']) await probe(m);
  console.log('\n=== СКЛАДСКИЕ ДОКУМЕНТЫ (правильный путь менять остаток) ===');
  for (const m of ['catalog.document.list','catalog.document.add','catalog.document.fields','catalog.document.conduct','catalog.document.update','catalog.document.element.add','catalog.document.element.list','catalog.document.element.fields']) await probe(m);
  console.log('\n=== СКЛАДЫ ===');
  for (const m of ['catalog.store.list','catalog.store.fields']) await probe(m);
  console.log('\n=== типы складских документов (enum) ===');
  try { console.log('  document.fields →', JSON.stringify(await client.call('catalog.document.fields', {})).slice(0,600)); } catch(e){ console.log('  ', e instanceof B24ApiError ? e.code : String(e)); }
})().catch(e => console.error('FATAL', e));
