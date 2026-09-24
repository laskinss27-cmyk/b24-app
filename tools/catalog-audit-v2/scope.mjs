// User clarification on 2026-09-06: do not fill kit/bundle cards.
// Deliberately conservative: skip all product names containing a kit/set word.
export const isExcludedKit = name => /(?:^|[^а-яёa-z])(?:комплект(?:ы|а|ов)?|набор(?:ы|а|ов)?|kit|bundle)(?:$|[^а-яёa-z])/iu.test(String(name))
  // Explicitly combined mechanism/frame cards are also artificial bundles,
  // even when their titles omit the word «комплект» (13552, 13556, 13558).
  || /(?:розетк|выключател).*\/.*постовая рамка.*GSL\d+\s*\/\s*GSL\d+/iu.test(String(name))
  // Combined cards and ready-made leak-protection sets whose names omit «комплект».
  || /(?:2шт\s*\/\s*компл|Лампочка с патроном Е27 40Вт|Аквасторож Классика 2×15|NEPTUN BUGATTI BASE|Gidrolock Ultimate Загородный дом|Neptun XP 5|Neptun PROFI Smart\+ 1\/2 Tuya|Orient HDMI 2\.0 Extender VE042|PoE Объединитель\/Разветвитель CM1)/iu.test(String(name));
