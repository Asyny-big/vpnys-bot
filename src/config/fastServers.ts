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
 */
export type FastServersJson = Readonly<Record<string, FastServerResult>>;

/**
 * Маппинг кода страны → флаг + красивое имя для подписки.
 */
const COUNTRY_DISPLAY: Readonly<Record<string, { flag: string; name: string }>> = {
    NL: { flag: "🇳🇱", name: "Нидерланды" },
    DE: { flag: "🇩🇪", name: "Германия" },
    FI: { flag: "🇫🇮", name: "Финляндия" },
};

/**
 * Порядок стран в подписке (сразу после основного сервера).
 */
const COUNTRY_ORDER: ReadonlyArray<string> = ["NL", "DE", "FI"];

export interface FastServerEntry {
    readonly displayName: string;
    readonly configUrl: string;
}

/**
 * Загружает JSON и возвращает список быстрых серверов с красивыми именами.
 * Если файл не существует или невалиден — возвращает пустой массив (graceful degradation).
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
        for (const countryCode of COUNTRY_ORDER) {
            const result = data[countryCode];
            if (!result?.config) continue;

            const display = COUNTRY_DISPLAY[countryCode];
            if (!display) continue;

            entries.push({
                displayName: `⚡ ${display.flag} ${display.name} — Быстрый`,
                configUrl: result.config,
            });
        }
        return entries;
    } catch {
        // Graceful degradation — не ломаем бота если JSON битый
        return [];
    }
}
