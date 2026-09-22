// Формулировки, которые банк может счесть намёком на обход ограничений (требование Platega).
// Используется скриптом npm run check-wording и при сохранении настроек в админке.
export const FORBIDDEN_WORDING = [
    /(?<![а-яё])обх[оа]д/i, /обойти/i, /блокир/i, /разблок/i, /цензур/i, /\bDPI\b/, /ТСПУ/i, /глуш/i,
    /бел(ый|ые|ых|ым) спис/i, /whitelist/i, /роскомнадзор/i, /\bРКН\b/, /запрещ[её]нн/i, /недоступн/i,
    /свобод/i, /анонимн/i, /геоблок/i, /гео-?огранич/i, /смен[аиу] (IP|страны|региона)/i,
    /youtube|instagram|facebook|discord|twitter|linkedin|netflix|chatgpt/i,
    /любые сайты/i, /без ограничений/i, /санкци/i,
];

export function findForbidden(text) {
    const s = String(text ?? '');
    const re = FORBIDDEN_WORDING.find((r) => r.test(s));
    return re ? s.match(re)[0] : null;
}
