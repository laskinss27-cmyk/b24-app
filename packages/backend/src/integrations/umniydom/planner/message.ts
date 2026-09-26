import { safeText } from '../message-format.js';
import type { PlannerEnvelope } from './schema.js';
export function plannerSummary(body: PlannerEnvelope) {
    const p = body.project;
    const names = { square: 'Квадрат', rectangle: 'Прямоугольник', l: 'Г-образный', t: 'Т-образный', u: 'П-образный', cross: 'Крестообразный', annex: 'С пристройкой' };
    const lines = [`Расчёт видеонаблюдения ${body.number}`, `${names[p.preset]}: ${p.width} × ${p.depth} м, высота ${p.height} м`, `Камер: ${p.cameras.length}. Зоны на высоте ${p.level} м.`, '', `Клиент: ${safeText(body.contact.name)}`, `Телефон: ${safeText(body.contact.phone)}`];
    if (body.contact.email) lines.push(`Email: ${safeText(body.contact.email)}`);
    lines.push('', 'Камеры на схеме:');
    p.cameras.forEach((c, index) => {
        const product = c.product ? body.products.find(row => row.id === c.product!.id) : null;
        lines.push(`${index + 1}. ${product ? safeText(product.name) : 'Условная камера — подобрать модель'}`, `Стена ${c.wall + 1}, ${Math.round(c.position * 100)}% от начала, высота ${c.height} м; поворот ${c.yaw}°, наклон ${c.tilt}°, обзор ${c.fov}°, ориентир ${c.range} м.`);
    });
    if (body.products.length) {
        lines.push('', 'Выбранные товары (цены на момент заявки, не итоговая смета):');
        for (const item of body.products) lines.push(`${safeText(item.name)} [${safeText(item.id)}] × ${item.quantity}: ${item.priceMinor === null ? 'нужна проверка цены и наличия' : (item.priceMinor / 100).toLocaleString('ru-RU') + ' ₽ / шт.'}; ${item.availability}`);
    }
    if (body.contact.comment) lines.push('', 'Пожелания клиента:', safeText(body.contact.comment));
    lines.push('', 'Приложены вид сверху, изометрия и JSON проекта. JSON открывается кнопкой «Открыть» в https://umniydom.pro/camera-planner.', 'Заявка на расчёт, без оплаты и резервирования. Геометрическая схема не учитывает препятствия на участке и качество изображения.');
    return lines.join('\n');
}
