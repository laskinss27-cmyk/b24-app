export function safeText(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/&/g, '＆').replace(/</g, '＜').replace(/>/g, '＞').replace(/\[/g, '［').replace(/\]/g, '］');
}
export function money(value: number | null): string {
    if (value === null) return 'цена по запросу';
    const whole = Math.floor(value / 100).toLocaleString('ru-RU'), cents = value % 100;
    return `${whole}${cents ? ',' + String(cents).padStart(2, '0') : ''} ₽`;
}
