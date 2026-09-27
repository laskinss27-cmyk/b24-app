import { money, safeText } from '../message-format.js';
import type { PlannerEnvelope } from './schema.js';

const presets = { square: 'Квадрат', rectangle: 'Прямоугольник', l: 'Г-образный', t: 'Т-образный', u: 'П-образный', cross: 'Крестообразный', annex: 'С пристройкой' };
const roles = { recorder: 'Регистратор', storage: 'Жёсткий диск', cable: 'Кабель', switch: 'Коммутатор', power: 'Блок питания', box: 'Монтажные коробки', videoConnector: 'Разъёмы видеолинии', powerConnector: 'Разъёмы питания' };
const availability = { in_stock: '', on_order: ' · под заказ', unavailable: ' · нет в наличии', unknown: ' · наличие уточнить' };
function brief(text: string, max: number) {
    const clean = safeText(text);
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/** Compact chat brief; the unabridged specification stays in the CRM timeline. */
export function plannerNotification(body: PlannerEnvelope, leadUrl: string) {
    const { project: p, contact, kit } = body;
    const lines = [
        `[B]Расчёт видеонаблюдения ${body.number}[/B]`,
        `${safeText(contact.name)} · ${safeText(contact.phone)}`,
        ...(contact.email ? [safeText(contact.email)] : []),
        '', `${presets[p.preset]}: ${p.width} × ${p.depth} м, высота дома ${p.height} м.`,
        `[B]Камеры — ${p.cameras.length} шт.[/B]`,
    ];
    for (const item of body.products) lines.push(`• ${brief(item.name, 100)} × ${item.quantity} шт.${availability[item.availability]}`);
    const unselected = p.cameras.filter(c => !c.product || !body.products.some(item => item.id === c.product!.id)).length;
    if (unselected) lines.push(`• Подобрать модель — ${unselected} шт.`);
    if (kit) {
        lines.push('', '[B]Выбранный комплект[/B]');
        if (!kit.items.length) lines.push('Клиент отказался от дополнительного оборудования.');
        for (const item of kit.items) lines.push(`• ${roles[item.role]}: ${brief(item.name, 100)} × ${item.quantity} ${item.unit}${availability[item.availability]}`);
        if (kit.declined.length) lines.push('Исключено клиентом: ' + kit.declined.map(role => roles[role].toLowerCase()).join(', ') + '.');
        lines.push(`Архив: ${kit.settings.days} суток. Ввод кабеля: стена ${kit.settings.entryWall + 1}; внутри дома ${kit.settings.indoor} м на линию.`);
    } else lines.push('', 'Дополнительное оборудование ещё не выбрано.');
    const priced = [...body.products, ...(kit?.items ?? [])];
    const known = priced.filter(item => item.priceMinor !== null);
    if (known.length) {
        const total = known.reduce((sum, item) => sum + item.priceMinor! * item.quantity, 0);
        const partial = unselected > 0 || known.length !== priced.length;
        lines.push('', `${partial ? 'Позиции с известной ценой' : 'Оборудование по ценам на момент заявки'}: ${money(total)}.`,
            partial ? 'Остальные цены и монтаж — уточнить. Это не полная смета.' : 'Монтаж не включён; стоимость и наличие подтвердить.');
    } else lines.push('', 'Стоимость оборудования и монтажа — уточнить.');
    if (contact.comment) lines.push('', 'Пожелания: ' + brief(contact.comment, 500));
    lines.push('', `[URL=${leadUrl}]Открыть заявку и полный состав[/URL]`, 'Вид сверху ↓ · изометрия следующим сообщением.');
    return lines.join('\n');
}
