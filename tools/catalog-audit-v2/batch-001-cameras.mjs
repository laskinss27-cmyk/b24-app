const f = (key, label, group, type, rawValue, unit = '') => ({key,label,group,type,rawValue,unit,filterable:true});
const n = (key, label, group, rawValue) => ({key,label,group,type:'text',rawValue,unit:'',filterable:false});
const base = (kind, form, mp, sensor, pixels) => [
  f('product_type','Вид товара','Идентификация','option',kind),
  f('form_factor','Исполнение','Идентификация','option',form),
  f('resolution','Разрешение','Изображение','number',`${mp} Мп`,'Мп'),
  ...(sensor ? [f('image_sensor','Матрица','Изображение','option',sensor)] : []),
  n('image_dimensions','Максимальный размер изображения','Изображение',pixels),
];
const lens = (mm, angle) => [
  f('lens_type','Тип объектива','Объектив','option','Фиксированный'),
  f('focal_length','Фокусное расстояние','Объектив','number',`${mm} мм`,'мм'),
  n('field_of_view','Угол обзора','Объектив',angle),
];
const power = (poe, max, detail) => [
  ...(poe === true ? [f('poe','PoE','Питание','boolean','Да'),f('poe_standard','Стандарт PoE','Питание','option','IEEE 802.3af')] : []),
  f('supply_voltage','Напряжение питания','Питание','number','12 В','В'),
  f('max_power_consumption','Максимальная потребляемая мощность','Питание','number',`${max} Вт`,'Вт'),
  n('power_supply','Питание и потребление','Питание',detail),
];
const env = (ip, temp, dimensions, weight) => [
  ...(ip ? [f('ip_rating','Степень защиты','Эксплуатация','option',ip)] : []),
  f('operating_temperature','Рабочая температура','Эксплуатация','range',temp,'°C'),
  n('dimensions','Габариты','Размеры',dimensions),
  n('net_weight','Масса нетто','Размеры',weight),
];
const wifi = () => [f('wifi','Wi-Fi','Подключения','boolean','Да'),f('wifi_band','Диапазон Wi-Fi','Подключения','option','2,4 ГГц'),n('wifi_standard','Стандарт Wi-Fi','Подключения','IEEE 802.11b/g/n')];
const network = (profiles) => [n('ethernet','Сетевой интерфейс','Подключения','RJ-45, 10/100 Мбит/с'),n('onvif_profiles','Профили ONVIF','Совместимость',profiles)];
const audio = () => [f('built_in_microphone','Встроенный микрофон','Аудио','boolean','Да'),f('built_in_speaker','Встроенный динамик','Аудио','boolean','Да'),f('two_way_audio','Двусторонняя аудиосвязь','Аудио','boolean','Да')];
const sd = (gb) => f('micro_sd_capacity','Максимальная ёмкость microSD','Хранение','number',`${gb} ГБ`,'ГБ');
const fps = (rate) => f('max_frame_rate','Максимальная частота кадров при полном разрешении','Видео','number',`${rate} к/с`,'к/с');
const codecs = (value) => f('video_codecs','Видеокодеки','Видео','multi_option',value);
const wdr = (value) => f('wdr','Широкий динамический диапазон','Изображение','option',value);
const ir = (m) => f('ir_distance','Дальность ИК-подсветки','Подсветка','number',`${m} м`,'м');
const white = (m) => f('warm_light_distance','Дальность светодиодной подсветки','Подсветка','number',`${m} м`,'м');
export { f, n, base, lens, power, env, wifi, network, audio, sd, fps, codecs, wdr, ir, white };

export default {
  batch:'001',
  reason:'Русские описания, исправление повреждённых полей и проверка характеристик шести камер с положительным остатком.',
  beforePath:'catalog-audit-v2/progress/batch-001-before.json',
  items:[
    {
      itemCode:'10800',category:'network_camera',
      summary:'Купольная Wi-Fi-видеокамера Dahua с разрешением 2 Мп и объективом 2,8 мм для наблюдения за помещениями и прилегающей территорией. ИК-подсветка работает на расстоянии до 30 м. Встроенные микрофон и динамик обеспечивают двустороннюю связь, запись возможна на microSD до 256 ГБ. Подключение по Wi-Fi 2,4 ГГц или Ethernet; питание 12 В.',
      sources:['https://www.dahuasecurity.com/ea/products/All-Products/Network-Cameras/Wireless-Series/Indoor-Camera/Turret-Series/IPC-HDW1230DT-STW','https://material.dahuasecurity.com/uploads/cpq/prm-os-srv-res/smart/datasheetzipfiles/IPC-HDW1230DT-STW_datasheet_20231121.pdf','https://material.dahuasecurity.com/uploads/cpq/prm-os-srv-res/smart/datasheetzipfiles/IPC-HDW1230DT-STW_datasheet_20220706.pdf'],
      attributes:[...base('IP-видеокамера','Купольная',2,'1/2,8″ CMOS','1920 × 1080'),...lens('2,8','горизонталь 100°, вертикаль 53°, диагональ 120°'),fps(25),codecs('H.264, H.265, Smart H.264+, Smart H.265+'),ir(30),wdr('DWDR'),...audio(),sd(256),...wifi(),...network('Profile S, Profile T'),...power(null,'6,1','12 В DC; базовое потребление 1,9 Вт, максимальное 6,1 Вт'),...env('IP67','-30…+60 °C','Ø109,9 × 102,2 мм','352 г'),n('analytics_features','Функции аналитики','Аналитика','обнаружение движения, заслона камеры и звука'),n('recording_mode','Режим основного потока','Видео','1920 × 1080 до 25 к/с для исполнения PAL (суффикс P)')],
      unresolved:['Комплектация адаптером может зависеть от поставки; её состав не добавлен без проверки упаковки.'],
    },
    {
      itemCode:'10856',category:'network_camera',
      summary:'Уличная цилиндрическая IP-видеокамера Hikvision AcuSense с разрешением 8 Мп и объективом 2,8 мм. Гибридная ИК- и белая подсветка работает до 40 м, аналитика различает людей и транспорт. Два встроенных микрофона записывают звук. Предусмотрены WDR 120 дБ, microSD до 512 ГБ и питание PoE или 12 В.',
      sources:['https://assets.hikvision.com/prd/normal/all/doc/m000117783/DS-2CD2083G2-LI2U_Datasheet_20260105.pdf'],
      attributes:[...base('IP-видеокамера','Цилиндрическая',8,'1/2,8″ CMOS','3840 × 2160'),...lens('2,8','горизонталь 108°, вертикаль 59°, диагональ 127°'),fps(20),codecs('H.264, H.265, H.264+, H.265+, MJPEG'),ir(40),white(40),wdr('120 дБ'),f('built_in_microphone','Встроенный микрофон','Аудио','boolean','Да'),f('microphone_count','Количество микрофонов','Аудио','number','2 шт.','шт.'),sd(512),...network('Profile S, Profile G'),...power(true,'7,5','12 В DC ±25%, до 6 Вт; PoE IEEE 802.3af, класс 3, до 7,5 Вт'),...env('IP67','-30…+60 °C','Ø74,4 × 176,3 мм','515 г'),n('analytics_features','Функции аналитики','Аналитика','классификация людей и транспорта; пересечение линии, вторжение, вход и выход из области'),n('body_material','Материал корпуса','Корпус','металл'),n('recording_mode','Режим основного потока','Видео','8 Мп до 20 к/с; при снижении разрешения до 25 к/с (50 Гц) или 30 к/с (60 Гц)')],
      unresolved:[],
    },
    {
      itemCode:'10928',category:'network_camera',
      summary:'Купольная IP-видеокамера Dahua с разрешением 4 Мп и объективом 2,8 мм. Двойная подсветка сочетает ИК- и тёплый свет с дальностью до 30 м. Поддерживаются обнаружение людей, WDR 120 дБ и запись звука встроенным микрофоном. Корпус IP67 подходит для уличной установки; питание через PoE или от источника 12 В.',
      sources:['https://www.dahuasecurity.com/ea/products/All-Products/Network-Cameras/-Entry/4-/IPC-HDW1439VP-A-IL','https://material.dahuasecurity.com/uploads/cpq/prm-os-srv-res/smart/datasheetzipfiles/IPC-HDW1439V-A-IL_S0_datasheet_20230720.pdf'],
      attributes:[...base('IP-видеокамера','Купольная',4,'1/2,9″ CMOS','2560 × 1440'),...lens('2,8','горизонталь 94°, вертикаль 52°, диагональ 111°'),fps(25),codecs('H.264, H.265, Smart H.264+, Smart H.265+, MJPEG'),ir(30),white(30),wdr('120 дБ'),f('built_in_microphone','Встроенный микрофон','Аудио','boolean','Да'),...network('Profile S, Profile T'),...power(true,'5,7','12 В DC или PoE IEEE 802.3af; максимум 4,6 Вт при 12 В и 5,7 Вт при PoE'),...env('IP67','-40…+60 °C','100,9 × Ø109,9 мм','330 г'),n('analytics_features','Функции аналитики','Аналитика','обнаружение людей и движения'),n('storage_support','Хранение','Хранение','FTP; сетевой видеорегистратор'),n('body_material','Материал корпуса','Корпус','внутренняя часть: металл и пластик; кожух: пластик'),n('recording_mode','Режим основного потока','Видео','2560 × 1440 до 25 к/с для исполнения PAL (суффикс P)')],
      unresolved:[],
    },
    {
      itemCode:'11932',category:'hdcvi_camera',
      summary:'Антивандальная купольная видеокамера Hikvision с разрешением 2 Мп и объективом 2,8 мм. Подключается к совместимому аналоговому регистратору в режиме TVI, AHD, CVI или CVBS. ИК-подсветка EXIR 2.0 работает до 30 м, WDR 120 дБ помогает при встречной засветке. Металлический корпус имеет защиту IP67 и IK10; питание 12 В.',
      sources:['https://www.hikvision.com/content/dam/hikvision/products/S000000001/S000000002/S000000146/S000000147/OFR000195/M000001723/Data_Sheet/DS-2CE57D3T-VPITF_Datasheet_20230807.pdf'],
      attributes:[...base('Аналоговая мультиформатная видеокамера','Купольная',2,null,'1920 × 1080'),n('image_sensor','Матрица','Изображение','CMOS, 2 Мп, прогрессивная развёртка'),...lens('2,8','горизонталь 106°'),f('video_standards','Видеостандарты','Видео','multi_option','TVI, AHD, CVI, CVBS'),n('recording_mode','Частота кадров','Видео','1920 × 1080: 25 к/с (PAL), 30 к/с (NTSC)'),ir(30),wdr('120 дБ'),...power(null,'4,6','12 В DC ±25%; максимум 4,6 Вт'),...env('IP67','-40…+60 °C','Ø110,8 × 84,7 мм','374 г'),f('impact_rating','Ударопрочность','Эксплуатация','option','IK10'),n('body_material','Материал корпуса','Корпус','металл'),n('noise_reduction','Шумоподавление','Изображение','3D DNR'),n('video_output','Видеовыход','Подключения','один аналоговый HD-выход с переключением TVI/AHD/CVI/CVBS')],
      unresolved:[],
    },
    {
      itemCode:'16858',category:'network_camera',
      summary:'Миниатюрная IP-видеокамера Acumen AiP-C24W-05Y2W «Коув» с разрешением 2 Мп для встраивания в банкоматы и терминалы. Видеомодуль вынесен отдельно от основного блока; расстояние между ними может достигать 6 м. Поддерживаются H.264/MJPEG, ONVIF, локальная запись на microSD/SDHC и двусторонний звук с внешним аудиооборудованием. Питание 12 В или PoE.',
      sources:['https://files.layta.ru/upload/files_upload/Acumen/pasporta/AiP-C24W-05Y2W_pasport.pdf'],
      attributes:[...base('IP-видеокамера','Модульная',2,'1/2,7″ CMOS','1920 × 1080'),fps(30),codecs('H.264, MJPEG'),...network('Profile S'),...power(true,'7,5','12 В DC ±10%, 6 Вт; PoE IEEE 802.3af, 7,5 Вт'),...env(null,'-25…+50 °C','основной блок 130 × 93 × 35 мм; видеомодуль Ø25 × 32 мм','основной блок 300 г; видеомодуль 180 г'),f('two_way_audio','Двусторонняя аудиосвязь','Аудио','boolean','Да'),n('audio_interfaces','Аудиоинтерфейсы','Аудио','вход и выход для внешних микрофона и динамика; G.711, PCM'),n('storage_support','Карты памяти','Хранение','microSD/SDHC; карта в комплект не входит'),n('analytics_features','Функции аналитики','Аналитика','обнаружение движения и действий с камерой; ROI, цифровой зум'),n('module_connection','Подключение видеомодуля','Подключения','RJ12, кабель до 6 м'),n('interfaces','Дополнительные интерфейсы','Подключения','RS-485; два цифровых тревожных входа и один релейный выход'),n('video_output','Аналоговый видеовыход','Подключения','CVBS, RCA'),n('use_case','Назначение','Применение','встраивание в банкоматы и платёжные терминалы')],
      unresolved:['Фокусное расстояние: паспорт на сайте Layta указывает 3,7 мм, каталог Acumen 2016 — 3,6 мм. Не добавлено до проверки исполнения. Предельная ёмкость карты памяти и степень защиты в точном паспорте не указаны.'],
    },
    {
      itemCode:'18456',category:'network_camera',
      summary:'Поворотная Wi-Fi-видеокамера Dahua с разрешением 5 Мп и объективом 4 мм для наблюдения за территорией. ИК- и белая подсветка работают до 30 м. Поддерживаются обнаружение людей, пересечение линии и вторжение, звуковое и световое предупреждение. Встроенные микрофон и динамик обеспечивают двустороннюю связь; запись на microSD до 512 ГБ. Питание 12 В.',
      sources:['https://material.dahuasecurity.com/uploads/cpq/prm-os-srv-res/smart/datasheetzipfiles/SD2A500HB-GN-AW-PV-S2_S0_datasheet_20230627.pdf','https://www.dahuasecurity.com/mena/products/All-Products/Discontinued-Products/Network-Cameras/SD2A500HB-GN-AW-PV-S2'],
      attributes:[...base('IP-видеокамера','Поворотная',5,'1/2,8″ CMOS','2560 × 1920'),...lens('4','горизонталь 80,4°, вертикаль 58,1°, диагональ 104,8°'),fps(20),codecs('H.264, H.265, Smart H.264+, Smart H.265+, MJPEG'),ir(30),white(30),wdr('DWDR'),...audio(),sd(512),...wifi(),...network('Profile S, Profile T'),...power(null,'11','12 В DC, 1,5 А ±10%; базовое потребление 3,5 Вт, максимальное 11 Вт'),...env('IP66','-30…+55 °C','140,5 × Ø111 мм','500 г'),f('motorized_pan_tilt','Моторизованный поворот и наклон','Механика','boolean','Да'),f('active_deterrence','Активное сдерживание','Аналитика','boolean','Да'),n('pan_tilt_range','Диапазон поворота и наклона','Механика','поворот 0…345°; наклон 0…80°'),n('analytics_features','Функции аналитики','Аналитика','обнаружение людей; пересечение линии; вторжение'),n('recording_mode','Режим основного потока','Видео','5 Мп до 20 к/с; при меньшем разрешении до 25/30 к/с')],
      unresolved:['Источник отмечает модель как снятую с производства. Статус в этом проходе не меняется: работа ограничена описанием и характеристиками.'],
    },
  ],
};
