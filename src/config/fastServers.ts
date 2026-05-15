/**
 * Загрузка и парсинг JSON-файла с лучшими серверами.
 * Graceful degradation: если файл отсутствует или невалиден — возвращаем пустой массив.
 */
import * as fs from "fs";

/**
 * Формат записи для одной страны в JSON.
 */
export interface FastServerResult {
    readonly name: string;
    readonly config: string; // vless:// или trojan://
}

/**
 * Формат JSON-файла — страны на верхнем уровне.
 * Пример: { "NL": { "name": "...", "config": "vless://..." }, "DE": {...} }
 *
 * Допустимые ключи:
 *   - двухбуквенный ISO-код страны: "NL", "DE", "FI", "RU", ...
 *   - "XX" — неизвестная/Cloudflare-anycast страна
 *   - "{CC}_{N}" — суффикс для повторов одной страны: "RU_2", "RU_3"
 *     (когда скрипт-отбора не нашёл достаточно уникальных стран и заполнил
 *     слоты лучшими по bandwidth серверами повторно).
 */
export type FastServersJson = Readonly<Record<string, FastServerResult>>;

/**
 * Русские названия популярных VPN-стран. Для стран не из этого списка
 * подпись будет просто кодом страны (e.g. "LB", "AL").
 */
const COUNTRY_NAMES_RU: Readonly<Record<string, string>> = {
    AE: "ОАЭ", AL: "Албания", AM: "Армения", AR: "Аргентина", AT: "Австрия",
    AU: "Австралия", AZ: "Азербайджан", BE: "Бельгия", BG: "Болгария",
    BR: "Бразилия", BY: "Беларусь", CA: "Канада", CH: "Швейцария", CL: "Чили",
    CN: "Китай", CY: "Кипр", CZ: "Чехия", DE: "Германия", DK: "Дания",
    EE: "Эстония", EG: "Египет", ES: "Испания", FI: "Финляндия", FR: "Франция",
    GB: "Великобритания", GE: "Грузия", GR: "Греция", HK: "Гонконг",
    HR: "Хорватия", HU: "Венгрия", ID: "Индонезия", IE: "Ирландия",
    IL: "Израиль", IN: "Индия", IR: "Иран", IS: "Исландия", IT: "Италия",
    JP: "Япония", KH: "Камбоджа", KR: "Корея", KZ: "Казахстан", LB: "Ливан",
    LT: "Литва", LU: "Люксембург", LV: "Латвия", MD: "Молдова", MX: "Мексика",
    MY: "Малайзия", NL: "Нидерланды", NO: "Норвегия", NZ: "Новая Зеландия",
    PH: "Филиппины", PL: "Польша", PT: "Португалия", RO: "Румыния", RS: "Сербия",
    RU: "Россия", SA: "Саудовская Аравия", SE: "Швеция", SG: "Сингапур",
    SK: "Словакия", TH: "Таиланд", TR: "Турция", TW: "Тайвань", UA: "Украина",
    US: "США", UZ: "Узбекистан", VN: "Вьетнам", ZA: "ЮАР",
};

/**
 * Превращает двухбуквенный ISO-код страны в emoji флаг.
 * Работает алгоритмически: 'A' (0x41) → 0x1F1E6 (🇦), 'B' → 0x1F1E7 (🇧) и т.д.
 * Невалидный код → 🌐.
 */
function countryCodeToFlag(cc: string): string {
    if (!/^[A-Z]{2}$/.test(cc)) return "🌐";
    const offset = 0x1F1E6 - "A".charCodeAt(0);
    return String.fromCodePoint(
        cc.charCodeAt(0) + offset,
        cc.charCodeAt(1) + offset
    );
}

/**
 * Формирует отображаемое имя для записи подписки.
 * Учитывает суффикс "_N" для дубликатов страны: "RU_2" → "🇷🇺 Россия #2".
 * Для неизвестных кодов: "🌐 LB" / "🌐 XX".
 */
function buildDisplayName(rawKey: string): string {
    const match = rawKey.match(/^([A-Z]{2})(?:_(\d+))?$/i);
    if (!match) {
        return `🌐 ${rawKey}`;
    }
    const cc = match[1]!.toUpperCase();
    const suffix = match[2] ? ` #${match[2]}` : "";

    if (cc === "XX") {
        return `🌐 Неизвестно${suffix}`;
    }
    const flag = countryCodeToFlag(cc);
    const name = COUNTRY_NAMES_RU[cc] ?? cc;
    return `${flag} ${name}${suffix}`;
}

export interface FastServerEntry {
    readonly displayName: string;
    readonly configUrl: string;
}

/**
 * Загружает JSON и возвращает список быстрых серверов с красивыми именами.
 * Если файл не существует или невалиден — возвращает пустой массив (graceful degradation).
 *
 * Принимает ЛЮБЫЕ ключи стран (не только NL/DE/FI). Порядок ключей в JSON
 * сохраняется (скрипт-отбора пишет в порядке убывания bandwidth).
 */
export function loadFastServers(jsonPath: string): ReadonlyArray<FastServerEntry> {
    try {
        if (!fs.existsSync(jsonPath)) {
            return [];
        }
        const raw = fs.readFileSync(jsonPath, "utf8");
        const data: FastServersJson = JSON.parse(raw);

        if (!data || typeof data !== "object") {
            return [];
        }

        const entries: FastServerEntry[] = [];
        for (const [rawKey, result] of Object.entries(data)) {
            if (!result?.config || typeof result.config !== "string") continue;
            entries.push({
                displayName: buildDisplayName(rawKey),
                configUrl: result.config,
            });
        }
        return entries;
    } catch {
        // Graceful degradation — не ломаем бота если JSON битый
        return [];
    }
}
