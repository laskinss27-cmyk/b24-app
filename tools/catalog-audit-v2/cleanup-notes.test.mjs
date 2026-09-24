import assert from 'node:assert/strict';
import test from 'node:test';
import {cleanContent,cleanSummary} from './cleanup-notes.mjs';
const attr=(label,rawValue)=>({key:label,id:label,label,rawValue});
test('removes user examples completely without choosing a conflicting number',()=>{
 const attributes=[
 attr('Дальность ИК по разным источникам','Складской исходник: до 30 м; архивный паспорт: 20 м. Ревизию сверить по экземпляру'),
 attr('Матрица и ревизия','CMOS 1/2,7 дюйма. Исходник: Starlight.base; архивный паспорт: Aptina AR0237'),
 attr('Уточнение объектива','В складском названии и архивном паспорте 3,6 мм; прежние 2,8 мм / 98° противоречат этому исполнению.'),
 attr('Степень защиты и ревизия','Исходник: IP67; архивный паспорт: IP66.'),
 attr('Габариты и ревизия','Исходник: Ø100 × 70 мм; архивный паспорт: Ø102 × 61 мм'),
 attr('Масса и ревизия','Исходник: 250 г; архивный паспорт: 240 г')];
 assert.equal(cleanContent({summary:'',attributes}).attributes.length,0);
});
test('preserves genuine product properties and known safety restrictions',()=>{
 const attributes=[attr('Источник питания','12 В DC'),attr('Кнопка проверки ТЕСТ','Да'),attr('Проверка работоспособности','кнопкой ТЕСТ или оптическим тестером ОТ-1'),attr('Защита от сверхтока','Нет'),attr('Диаметр сверления','6 мм'),attr('Архив','до 60 дней'),attr('Источник света','светодиоды'),attr('Применение','Не применять к недиммируемым лампам')];
 assert.deepEqual(cleanContent({summary:'',attributes}).attributes,attributes);
});
test('keeps factual sentences but removes editorial reasoning',()=>{
	assert.equal(cleanSummary('Камера. По исходным сведениям дальность 30 м.'),'Камера.');
	assert.equal(cleanContent({summary:'',attributes:[attr('Идентификация','производитель и точная модель отсутствуют')]}).attributes.length,0);
	assert.equal(cleanSummary('Промежуточное реле для круглосуточной работы.'),'Промежуточное реле для круглосуточной работы.');
 assert.equal(cleanSummary('Камера с объективом 3,6 мм. Исходник: IP67; архивный паспорт: IP66. Ревизию сверить по экземпляру.'),'Камера с объективом 3,6 мм.');
 assert.equal(cleanContent({summary:'',attributes:[attr('Исполнение','предположительно уличное')]}).attributes.length,0);
});
