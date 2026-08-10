type Address = Record<string, unknown>;
type Requisite = Record<string, unknown>;
type BankDetail = Record<string, unknown>;

interface KnownOwnCompany {
	requisite: Requisite;
	address: Address;
	bank: BankDetail;
	certificate?: string;
}

export const KNOWN_OWN_COMPANIES: Record<string, KnownOwnCompany> = {
	'780525373242': {
		requisite: { RQ_NAME: 'Поляков Дмитрий Юрьевич', RQ_INN: '780525373242', RQ_OGRNIP: '310784730600340' },
		address: { POSTAL_CODE: '198096', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'проспект Стачек, д. 59, кв. 328' },
		bank: {
			RQ_BANK_NAME: 'Филиал «Центральный» Банка ВТБ (ПАО)',
			RQ_BIK: '044525411',
			RQ_COR_ACC_NUM: '30101810145250000411',
			RQ_ACC_NUM: '40802810626280002991',
		},
		certificate: 'Серия и № Свидетельства 78 007832908 от 02.11.2010',
	},
	'470379634080': {
		requisite: { RQ_NAME: 'Нагайцев Олег Александрович', RQ_INN: '470379634080', RQ_OGRNIP: '316470400108991' },
		address: { POSTAL_CODE: '194100', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'Большой Сампсониевский проспект, д. 70' },
		bank: {
			RQ_BANK_NAME: 'Северо-Западный банк ПАО Сбербанк',
			RQ_BIK: '044030653',
			RQ_COR_ACC_NUM: '30101810500000000653',
			RQ_ACC_NUM: '40802810855000482445',
		},
	},
	'7816287495': {
		requisite: {
			RQ_COMPANY_NAME: 'ООО «Новый Дом»',
			RQ_COMPANY_FULL_NAME: 'Общество с ограниченной ответственностью «Новый Дом»',
			RQ_DIRECTOR: 'Забоев Григорий Анатольевич',
			RQ_INN: '7816287495',
			RQ_KPP: '781601001',
			RQ_OGRN: '1157847344797',
		},
		address: { POSTAL_CODE: '192102', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'ул. Стрельбищенская, д. 15А, корп. 2, лит. А, помещение 6Н' },
		bank: {
			RQ_BANK_NAME: 'Филиал «Санкт-Петербургский» АО «Альфа-Банк»',
			RQ_BIK: '044030786',
			RQ_COR_ACC_NUM: '30101810600000000786',
			RQ_ACC_NUM: '40702810332060006744',
		},
	},
	'7816473082': {
		requisite: {
			RQ_COMPANY_NAME: 'ООО «Дом Бизнес Строй»',
			RQ_COMPANY_FULL_NAME: 'Общество с ограниченной ответственностью «Дом Бизнес Строй»',
			RQ_DIRECTOR: 'Нагайцев Олег Александрович',
			RQ_INN: '7816473082',
			RQ_KPP: '781601001',
			RQ_OGRN: '1097847284810',
		},
		address: { POSTAL_CODE: '192102', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'ул. Стрельбищенская, д. 15, корп. 2, лит. А, помещение 6-Н' },
		bank: {
			RQ_BANK_NAME: 'Северо-Западный банк ПАО Сбербанк',
			RQ_BIK: '044030653',
			RQ_COR_ACC_NUM: '30101810500000000653',
			RQ_ACC_NUM: '40702810255100001743',
		},
	},
	'7842177523': {
		requisite: {
			RQ_COMPANY_NAME: 'ООО «И-ОН»',
			RQ_COMPANY_FULL_NAME: 'Общество с ограниченной ответственностью «И-ОН»',
			RQ_DIRECTOR: 'Поляков Дмитрий Юрьевич',
			RQ_INN: '7842177523',
			RQ_KPP: '780501001',
			RQ_OGRN: '1197847241855',
		},
		address: { POSTAL_CODE: '198096', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'МО Автово, проспект Стачек, д. 59, лит. А' },
		bank: {
			RQ_BANK_NAME: 'Северо-Западный банк ПАО Сбербанк',
			RQ_BIK: '044030653',
			RQ_COR_ACC_NUM: '30101810500000000653',
			RQ_ACC_NUM: '40702810355000037186',
		},
	},
	'7816268460': {
		requisite: {
			RQ_COMPANY_NAME: 'ООО «РА Анемоне»',
			RQ_COMPANY_FULL_NAME: 'Общество с ограниченной ответственностью «Рекламное Агентство Анемоне»',
			RQ_DIRECTOR: 'Поляков Дмитрий Юрьевич',
			RQ_INN: '7816268460',
			RQ_KPP: '781601001',
			RQ_OGRN: '1157847184637',
		},
		address: { POSTAL_CODE: '192102', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'ул. Стрельбищенская, д. 15, корп. 2, лит. А, помещение 6-Н' },
		bank: {
			RQ_BANK_NAME: 'Филиал «Центральный» Банка ВТБ (ПАО)',
			RQ_BIK: '044525411',
			RQ_COR_ACC_NUM: '30101810145250000411',
			RQ_ACC_NUM: '40702810617130004006',
		},
	},
};
