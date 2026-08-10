import type { ContractDurationUnit, ContractParty } from './deal-contract-types.js';

type Address = Record<string, unknown>;

const clean = (value: unknown): string => String(value ?? '').trim();

export const titleCase = (value: string): string => value.toLocaleLowerCase('ru-RU').replace(
	/(^|[\s«»"'“”„-])([\p{L}])/gu,
	(_, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase('ru-RU')}`,
);

export function shortPersonName(fullName: string): string {
	const parts = titleCase(fullName).split(/\s+/).filter(Boolean);
	if (!parts.length) return '';
	return `${parts[0]}${parts[1] ? ` ${parts[1][0]}.` : ''}${parts[2] ? `${parts[2][0]}.` : ''}`;
}

function personGenitive(fullName: string): string {
	const [surname = '', first = '', patronymic = ''] = titleCase(fullName).split(/\s+/);
	const female = /вна$/i.test(patronymic);
	const surnameGen = female
		? /ова$|ева$|ина$/i.test(surname) ? `${surname.slice(0, -1)}ой` : /ая$/i.test(surname) ? `${surname.slice(0, -2)}ой` : surname
		: /ов$|ев$|ин$/i.test(surname) ? `${surname}а` : /ий$/i.test(surname) ? `${surname.slice(0, -2)}ого` : surname;
	const knownFirst: Record<string, string> = {
		Дмитрий: 'Дмитрия', Олег: 'Олега', Григорий: 'Григория', Сергей: 'Сергея',
		Иван: 'Ивана', Александр: 'Александра', Андрей: 'Андрея', Алексей: 'Алексея',
	};
	const firstGen = female
		? /а$/i.test(first) ? `${first.slice(0, -1)}ы`.replace(/([гкх])ы$/i, '$1и') : /я$/i.test(first) ? `${first.slice(0, -1)}и` : first
		: knownFirst[first] ?? (/[йь]$/i.test(first) ? `${first.slice(0, -1)}я` : `${first}а`);
	const patronymicGen = female && /на$/i.test(patronymic)
		? `${patronymic.slice(0, -1)}ы`
		: /ич$/i.test(patronymic) ? `${patronymic}а` : patronymic;
	return [surnameGen, firstGen, patronymicGen].filter(Boolean).join(' ');
}

function namedRole(fullName: string): 'именуемый' | 'именуемая' {
	const patronymic = titleCase(fullName).split(/\s+/)[2] ?? '';
	return /вна$/i.test(patronymic) ? 'именуемая' : 'именуемый';
}

export function addressText(address: Address | null): string {
	if (!address) return '';
	const parts = [
		clean(address['POSTAL_CODE']),
		clean(address['COUNTRY']),
		clean(address['PROVINCE']),
		clean(address['REGION']),
		clean(address['CITY']),
		clean(address['ADDRESS_1']),
		clean(address['ADDRESS_2']),
	].filter(Boolean);
	return parts.join(', ');
}

export function partyPreamble(party: ContractParty, role: string): string {
	if (party.kind === 'person') {
		return `${titleCase(party.fullName)}, ${namedRole(party.fullName)} в дальнейшем «${role}»`;
	}
	if (party.kind === 'ip') {
		const name = titleCase(clean(party.requisite?.['RQ_NAME']) || party.fullName);
		return `Индивидуальный предприниматель ${name}, `
			+ `(ОГРНИП ${clean(party.requisite?.['RQ_OGRNIP'])}), ${namedRole(name)} в дальнейшем «${role}»`;
	}
	return `${companyLegalName(party)}, именуемое в дальнейшем «${role}», в лице Генерального директора `
		+ `${personGenitive(party.director)}, действующего на основании Устава`;
}

function companyLegalName(party: ContractParty): string {
	const rq = party.requisite ?? {};
	const source = clean(rq['RQ_COMPANY_FULL_NAME']) || party.fullName || clean(rq['RQ_COMPANY_NAME']) || party.title;
	const expanded = source.replace(/^\s*ООО(?=\s|[«"'])\s*/i, 'Общество с ограниченной ответственностью ');
	if (/[a-zа-яё]/u.test(expanded)) return expanded;
	return titleCase(expanded).replace(
		/^Общество С Ограниченной Ответственностью/u,
		'Общество с ограниченной ответственностью',
	);
}

export function partyRequisites(party: ContractParty): string {
	if (party.kind === 'person') {
		return [party.fullName, party.email ? `E-mail: ${party.email}` : ''].filter(Boolean).join('\n');
	}
	const rq = party.requisite ?? {};
	const bank = party.bank ?? {};
	const address = addressText(party.address);
	const rows = [
		party.kind === 'ip' ? `ИП ${titleCase(clean(rq['RQ_NAME']) || party.fullName)}` : party.shortName,
		address ? `${party.kind === 'company' ? 'Юридический адрес: ' : ''}${address}` : '',
		`ИНН ${clean(rq['RQ_INN'])}`,
		party.kind === 'company' ? `КПП ${clean(rq['RQ_KPP'])}` : '',
		party.kind === 'ip' ? `ОГРНИП ${clean(rq['RQ_OGRNIP'])}` : `ОГРН ${clean(rq['RQ_OGRN'])}`,
		party.certificate,
		clean(bank['RQ_BANK_NAME']),
		clean(bank['RQ_BIK']) ? `БИК ${clean(bank['RQ_BIK'])}` : '',
		clean(bank['RQ_COR_ACC_NUM']) ? `К/с ${clean(bank['RQ_COR_ACC_NUM'])}` : '',
		clean(bank['RQ_ACC_NUM']) ? `Р/с ${clean(bank['RQ_ACC_NUM'])}` : '',
	];
	return rows.filter((row) => row && !row.endsWith(' ')).join('\n');
}

export function signature(party: ContractParty): string {
	const fullName = titleCase(party.kind === 'company'
		? party.director
		: clean(party.requisite?.['RQ_NAME']) || party.fullName);
	const line = `_____________/ ${shortPersonName(fullName)} /`;
	return party.kind === 'company'
		? `Генеральный директор\n${line}\nМ.П.`
		: line;
}

export function completionActPartyName(party: ContractParty): string {
	if (party.kind === 'company') return companyLegalName(party);
	if (party.kind === 'ip') return `ИП ${titleCase(clean(party.requisite?.['RQ_NAME']) || party.fullName)}`;
	return titleCase(party.fullName);
}

export function contractorEmail(party: ContractParty): string {
	const inn = clean(party.requisite?.['RQ_INN']);
	const known: Record<string, string> = {
		'780525373242': 'manager@umniydom.pro',
		'470379634080': 'buh@umdim.ru',
		'7816287495': 'buh@homelogicsoft.com',
		'7816473082': 'buh@dom-electro.ru',
		'7842177523': 'buh@umniydom.pro',
		'7816268460': 'buh@anemone.su',
	};
	return known[inn] ?? party.email;
}

function numberForms(value: number, forms: [string, string, string]): string {
	const mod100 = value % 100;
	const mod10 = value % 10;
	if (mod100 >= 11 && mod100 <= 19) return forms[2];
	if (mod10 === 1) return forms[0];
	if (mod10 >= 2 && mod10 <= 4) return forms[1];
	return forms[2];
}

function integerToWords(value: number): string {
	if (value === 0) return 'ноль';
	const ones = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
	const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
	const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
	const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
	const groups = [
		{ forms: ['', '', ''] as [string, string, string], female: false },
		{ forms: ['тысяча', 'тысячи', 'тысяч'] as [string, string, string], female: true },
		{ forms: ['миллион', 'миллиона', 'миллионов'] as [string, string, string], female: false },
		{ forms: ['миллиард', 'миллиарда', 'миллиардов'] as [string, string, string], female: false },
	];
	const parts: string[] = [];
	let rest = Math.floor(value);
	for (let groupIndex = 0; rest > 0 && groupIndex < groups.length; groupIndex++) {
		const chunk = rest % 1000;
		rest = Math.floor(rest / 1000);
		if (!chunk) continue;
		const words: string[] = [];
		words.push(hundreds[Math.floor(chunk / 100)] ?? '');
		const tail = chunk % 100;
		if (tail >= 10 && tail < 20) {
			words.push(teens[tail - 10] ?? '');
		} else {
			words.push(tens[Math.floor(tail / 10)] ?? '');
			const one = tail % 10;
			if (groups[groupIndex]?.female && one === 1) words.push('одна');
			else if (groups[groupIndex]?.female && one === 2) words.push('две');
			else words.push(ones[one] ?? '');
		}
		const forms = groups[groupIndex]?.forms;
		if (forms?.[0]) words.push(numberForms(chunk, forms));
		parts.unshift(words.filter(Boolean).join(' '));
	}
	return parts.join(' ');
}

export function moneyWords(value: number): string {
	const rubles = Math.floor(value + 0.00001);
	const kopecks = Math.round((value - rubles) * 100);
	const words = integerToWords(rubles);
	return `${words[0]?.toLocaleUpperCase('ru-RU') ?? ''}${words.slice(1)} `
		+ `${numberForms(rubles, ['рубль', 'рубля', 'рублей'])} `
		+ `${String(kopecks).padStart(2, '0')} ${numberForms(kopecks, ['копейка', 'копейки', 'копеек'])}`;
}

export function contractWorkDuration(value: number, unit: ContractDurationUnit): string {
	const duration = Math.max(1, Math.min(3650, Math.trunc(value)));
	const words = integerToWords(duration);
	const dayForms: [string, string, string] = unit === 'working'
		? ['рабочий день', 'рабочих дня', 'рабочих дней']
		: ['календарный день', 'календарных дня', 'календарных дней'];
	return `${duration} (${words}) ${numberForms(duration, dayForms)}`;
}

export function contractDateText(dateIso: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
	if (!match) return dateIso;
	const monthNames = [
		'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
		'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
	];
	const monthIndex = Number(match[2]) - 1;
	const day = Number(match[3]);
	if (!monthNames[monthIndex] || day < 1 || day > 31) return dateIso;
	return `«${day}» ${monthNames[monthIndex]} ${match[1]} г.`;
}

export function formatMoney(value: number): string {
	return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
