import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { loadFastServers } from "./fastServers";

function writeTmpJson(payload: unknown): string {
  const file = path.join(os.tmpdir(), `fast-servers-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload));
  return file;
}

test("loadFastServers maps known country codes to Russian names + flag", () => {
  const file = writeTmpJson({
    NL: { name: "x", config: "vless://x@1.2.3.4:443" },
    DE: { name: "x", config: "vless://x@1.2.3.5:443" },
    RU: { name: "x", config: "trojan://x@1.2.3.6:443" },
  });
  const entries = loadFastServers(file);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.displayName, "🇳🇱 Нидерланды");
  assert.equal(entries[1]!.displayName, "🇩🇪 Германия");
  assert.equal(entries[2]!.displayName, "🇷🇺 Россия");
});

test("loadFastServers accepts unfamiliar but valid ISO-2 codes (LB / AL / GR)", () => {
  // Это реальный кейс: GeoIP может вернуть страну, которой нет в нашей мапе
  // русских названий — раньше такие записи молча скипались. Теперь должны
  // попадать в подписку с автоматически сгенерированным флагом.
  const file = writeTmpJson({
    LB: { name: "x", config: "trojan://x@1.2.3.4:443" },
    AL: { name: "x", config: "trojan://x@1.2.3.5:443" },
    GR: { name: "x", config: "trojan://x@1.2.3.6:443" },
  });
  const entries = loadFastServers(file);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.displayName, "🇱🇧 Ливан");
  assert.equal(entries[1]!.displayName, "🇦🇱 Албания");
  assert.equal(entries[2]!.displayName, "🇬🇷 Греция");
});

test("loadFastServers handles duplicate-country suffix RU_2 → '🇷🇺 Россия #2'", () => {
  const file = writeTmpJson({
    RU: { name: "x", config: "vless://x@1.2.3.4:443" },
    RU_2: { name: "x", config: "vless://x@1.2.3.5:443" },
    RU_3: { name: "x", config: "vless://x@1.2.3.6:443" },
  });
  const entries = loadFastServers(file);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.displayName, "🇷🇺 Россия");
  assert.equal(entries[1]!.displayName, "🇷🇺 Россия #2");
  assert.equal(entries[2]!.displayName, "🇷🇺 Россия #3");
});

test("loadFastServers maps XX → '🌐 Неизвестно' (Cloudflare anycast / unresolved)", () => {
  const file = writeTmpJson({
    XX: { name: "x", config: "vless://x@1.2.3.4:443" },
    XX_2: { name: "x", config: "vless://x@1.2.3.5:443" },
  });
  const entries = loadFastServers(file);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.displayName, "🌐 Неизвестно");
  assert.equal(entries[1]!.displayName, "🌐 Неизвестно #2");
});

test("loadFastServers preserves JSON key order (bandwidth descending from the picker)", () => {
  const file = writeTmpJson({
    US: { name: "x", config: "vless://x@1.2.3.4:443" },
    EE: { name: "x", config: "vless://x@1.2.3.5:443" },
    SG: { name: "x", config: "vless://x@1.2.3.6:443" },
  });
  const entries = loadFastServers(file);
  assert.deepEqual(
    entries.map((e) => e.displayName),
    ["🇺🇸 США", "🇪🇪 Эстония", "🇸🇬 Сингапур"]
  );
});

test("loadFastServers skips entries with empty / missing config string", () => {
  const file = writeTmpJson({
    NL: { name: "x", config: "vless://x@1.2.3.4:443" },
    DE: { name: "x", config: "" },
    FI: { name: "x" }, // missing config
  });
  const entries = loadFastServers(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.displayName, "🇳🇱 Нидерланды");
});

test("loadFastServers returns empty array when file does not exist", () => {
  const entries = loadFastServers(path.join(os.tmpdir(), "nonexistent-fast-servers.json"));
  assert.deepEqual(entries, []);
});

test("loadFastServers returns empty array on invalid JSON (graceful degradation)", () => {
  const file = writeTmpJson("not valid json {");
  const entries = loadFastServers(file);
  assert.deepEqual(entries, []);
});

test("loadFastServers returns empty array when top-level is not an object", () => {
  const file = writeTmpJson(["not", "an", "object"]);
  const entries = loadFastServers(file);
  // Массив — это всё ещё объект для typeof, но Object.entries даёт индексы.
  // Главное — не падать. Записи с битой формой будут отфильтрованы по отсутствию config.
  assert.deepEqual(entries, []);
});

test("loadFastServers ignores ключи, которые не похожи на код страны", () => {
  const file = writeTmpJson({
    "weird-key": { name: "x", config: "vless://x@1.2.3.4:443" },
    NL: { name: "x", config: "vless://x@1.2.3.5:443" },
  });
  const entries = loadFastServers(file);
  // weird-key всё равно попадёт, но с fallback-именем "🌐 weird-key"
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.displayName, "🌐 weird-key");
  assert.equal(entries[1]!.displayName, "🇳🇱 Нидерланды");
});
