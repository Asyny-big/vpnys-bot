# LisVPN / vpnys-bot — Device Identification: Root Cause + Production-Safe Migration Plan

> **Status (as of this commit):**
> - **Phase 0 — telemetry only — MERGED** (`X-Hwid` / `X-Device-*` parsing + structured `happIdentity` log, no behavior change). See PR #3.
> - **Mojibake fix — MERGED** (Russian device-error strings restored from CP1251→UTF-8 double encoding). See PR #4.
> - **Phase 1 / 2 / 3 / 4 — pending.** Will be implemented as separate, additive PRs; each phase ships behind a feature flag where appropriate, with shadow-mode before enforce-mode.
>
> This document is the canonical plan. Update it when a phase ships, do **not** rewrite history.

Все изменения предлагаются как **поэтапные, аддитивные, с feature-flag и shadow-mode**.

---

## TL;DR

1. **Главный root cause плавающего fingerprint у Happ — не "Happ виноват", а собственная двойная формула canonical-fingerprint** в `src/utils/deviceDetect.ts`. Один и тот же Happ-клиент даёт **две разные canonical-формулы** в зависимости от того, есть ли `model` в UA / Client Hints. Логи в задаче (`exact` → `heuristic`) — прямое следствие именно этого, а не нестабильности самого Happ.

2. **У Happ уже есть de-facto industry-standard стабильной идентификации** для подписок: HTTP-заголовки **`x-hwid` / `x-device-os` / `x-ver-os` / `x-device-model`** (+ legacy `x-device-info`). Они описаны не в Happ-docs (там описание скрыто), а в стандарте провайдеров (Remnawave) и в release notes Happ Android 1.16.0:
   > *Add "Send HWID" toggle to "Subscription" screen; it allows to pass **X-HWID** and **X-Device-Info** headers to providers.*
   Эти же заголовки использует Remnawave как production-механизм HWID-limit и явно пишет: *"A standard for providing headers is offered by Happ."*

3. Нужна **строго инкрементальная эволюция текущей системы**:
   - Phase 0 — telemetry-only (читаем заголовки, ничего не меняем).
   - Phase 1 — additive schema (новые nullable-колонки + раздельные индексы).
   - Phase 2 — shadow matching (новая логика считается рядом со старой, но не применяется; пишем diff).
   - Phase 3 — promote new keys за feature flag.
   - Phase 4 — постепенный cleanup, fallback на старую логику остаётся навсегда.

   **Никакого rewrite. Никаких destructive миграций. Никакой потери уже зарегистрированных устройств.**

4. Дополнительно найден **сопутствующий баг (не device-fingerprinting, но production-visible)**: тексты ошибок в `src/modules/devices/deviceService.ts` (строки 82, 150, 276, 301) — mojibake (CP1251 → UTF-8 двойное кодирование). Пользователь, превысивший лимит, фактически получает `РџРѕРґРїРёСЃРєР° РёСЃС‚РµРєР»Р°…` вместо `Подписка истекла…`. Чинится отдельным мини-PR, к device-identification не относится.

---

## 1. Что я прочитал в репо

| Файл | Роль |
|---|---|
| `prisma/schema.prisma` (DeviceConfig, Subscription) | DeviceConfig: `(userId, fingerprint) @@unique`, опциональный `clientId`. Лимит хранится в `Subscription.deviceLimit`. |
| `src/utils/deviceDetect.ts` | Парсинг UA + Client Hints, расчёт `fingerprint` и `fingerprintCandidates`. |
| `src/modules/devices/deviceService.ts` | `registerDevice` с тремя стратегиями: exact / candidate / heuristic + `findWeakPlatformMatch` + `collapseDuplicateDevices` + `preserveFingerprint` mode. |
| `src/http/subscription.ts` (handler `/sub/:token`, строки ~1169–1349) | Единственная точка регистрации устройства. Реагирует `LIMIT_REACHED` → возвращает пустой subscription body с `announce`-уведомлением. |
| `prisma/migrations/20260201120000_device_management/` + `20260202140000_device_client_id/` | История миграций DeviceConfig. |

Карта матчинга (упрощённо), как сейчас:

```
incoming /sub/:token
  ├── parseWithClientHints(headers)
  │     → DeviceInfo { platform, model, fingerprint (canonical), fingerprintCandidates[] }
  └── DeviceService.registerDevice(userId, deviceInfo, isActive)
        1. exact:        device.fingerprint === incoming.fingerprint
        2. candidate:    device.fingerprint ∈ incoming.fingerprintCandidates
        3. weakReuse:    (если есть свободный слот И incoming слабая identity)
                         → переписать слабое устройство (preserveFingerprint=true)
        4. heuristic:    (если currentDevices >= totalLimit)
                         → одна из эвристик по platform/model;
                         → preserveFingerprint=true
        5. иначе:        создаём новое устройство
```

---

## 2. Root cause — почему один и тот же Happ даёт разные fingerprint

### 2.1. Двойная canonical-формула

`src/utils/deviceDetect.ts:219-233` (`generateCanonicalFingerprint`):

```ts
if (data.platform === "Android" && normalizedModel) {
  return shortSha256(`android-model-v1|${data.platform}|${normalizedModel}`);
}
return generateStableFingerprint({ ua, platform });   // hash(normalizedUA | platform)
```

Это **два полностью разных пространства fingerprint-ов** для одного и того же устройства:

| Сценарий | Canonical input | Результат |
|---|---|---|
| Happ присылает `model=Redmi Note 8 Pro` | `android-model-v1\|Android\|redmi note 8 pro` | `7b89ed987b619c54` |
| Happ присылает `model=Unknown` | `happ/#/android/17782185961531805698\|Android` (после `normalizeUserAgentForFingerprint`) | `1eca4312e9356212` |

Это **ровно тот случай из задачи**. Не Happ "плавает" — fingerprint **по дизайну** разный, потому что формула меняется.

`fingerprintCandidates` спасает только частично: в кандидатах оба варианта присутствуют, но **только если запрос с model уже прошёл и было записано `device.fingerprint = 7b89ed987b619c54`**, тогда последующий запрос с `model=Unknown` найдёт его через `candidate`-match (т.к. legacy-fingerprint совпадёт). На практике порядок «без model сначала, с model потом» ломает: первый запрос создаёт device с `fingerprint=1eca4312e9356212`, а в следующем приходе с model второй запрос ищет `7b89ed987b619c54` в candidates → не находит → heuristic → reuse (если повезёт) или новый слот.

### 2.2. Почему `heuristic` спасает не всегда

`findHeuristicMatch` срабатывает **только когда `currentDevices >= totalLimit`** (см. `deviceService.ts:132-146`). Это:
- На `deviceLimit=1` действительно прикрывает большинство случаев — почти всегда есть match по platform.
- На `deviceLimit>=2` (купленный слот): если уже есть `Android + strong identity` (Redmi Note 8 Pro), а второй слот ещё пуст — `weakReuseMatch` (см. строка 115-117) переписывает **первое попавшееся слабое устройство**, что может конфликтовать с реальным вторым устройством пользователя.
- На переходе `weak → strong` (Happ повторно прислал model): heuristic находит `samePlatformStrong[0]` по той же модели, но если до этого было создано "weak" device (Android #2) с другим fingerprint — слот сгорает.

### 2.3. Почему сравнительно редкий случай "вчера работало — сегодня LIMIT_REACHED"

Сценарий, который воспроизводится по коду:

1. Купили 2 слота (`deviceLimit=2`).
2. Happ #1 (Android, model=Redmi) → создаёт device A с `fingerprint=strong(Redmi)`.
3. Happ #2 (iPad, model=iPad) → создаёт device B с `fingerprint=hash(ua|iOS)` (iOS не имеет "strong identity" в текущем коде; см. `hasStrongIdentity` — true только для Android+model).
4. Happ #1 ребутится / WebView обновился → пришёл с `model=Unknown` → canonical fp другой, candidate не совпал → `weakReuseMatch` срабатывает на iPad (т.к. iOS считается weak) — **iPad съедает Android-слот**, а через минуту настоящий iPad возвращается → новый слот, не помещается → LIMIT_REACHED.

То есть `weakReuseMatch` (без проверки `platform === incoming.platform` в части iOS/iPad как «weak») и/или `findWeakPlatformMatch` могут "перекидывать" слот между Android и iOS при определённых комбинациях. Стоит проверить production-логи на наличие `matchStrategy=heuristic` с `collapsedDuplicates>0` и сменой `platform`.

`findWeakPlatformMatch` сам по себе ограничивает кросс-платформенный матчинг (строка 413: `device.platform === deviceInfo.platform`), это хорошо. Но **в текущей реализации iOS всегда weak** (`hasStrongIdentity` возвращает true только для Android+model) — на iOS любой повторный заход через iCloud restore/новый Safari WebView session может схлопывать iPhone в iPad и наоборот, если у пользователя 2 iOS-устройства.

---

## 3. Что Happ реально умеет (источники: Happ docs, Remnawave docs, Happ release notes, реверс-логи сообщества)

### 3.1. HTTP-заголовки, которые Happ шлёт при запросе подписки

Это **production-стандарт**, на который ориентируются Remnawave, форки v2rayNG и др.:

```
GET /sub/<token> HTTP/1.1
User-Agent: Happ/3.20.4/Android/17782185961531805698   ← см. ниже про trailing token
X-Hwid: <стабильный hwid устройства>
X-Device-Os: Android | iOS | Windows | macOS | Linux
X-Ver-Os: 18.3
X-Device-Model: Redmi Note 8 Pro
X-Device-Locale: ru             (старые версии)
X-Device-Info: <combined>       (старые версии 1.16.x для legacy-провайдеров)
```

Источники:
- [Happ Privacy Policy](https://www.happ.su/main/privacy-policy): *"By default, the app also sends a unique device identifier (HWID) and the device model in HTTP headers when requesting subscription data … Users can disable HWID transmission in the app settings."*
- [Happ Android 1.16.0 release notes](https://newreleases.io/project/github/Happ-proxy/happ-android/release/1.16.0): *"Add 'Send HWID' toggle … it allows to pass **X-HWID** and **X-Device-Info** headers to providers."*
- [Remnawave HWID device limit](https://remna.st/docs/features/hwid-device-limit): *"A standard for providing headers is offered by Happ … the application should send the following headers: `x-hwid`, `x-device-os`, `x-ver-os`, `x-device-model`, `user-agent`. The only required item is `x-hwid`."*

**Важно**: `x-hwid` — **opt-out toggle** в Happ. Конкретные пользователи могут его отключить → заголовка не будет. Поэтому **нельзя жёстко требовать `x-hwid`** (иначе 404 как Remnawave — но тогда «вчера работало, сегодня нет»).

### 3.2. То, что **НЕ относится** к учёту устройств у нас

- **InstallID / Limited Links** — Happ-side фича: `happ-proxy.com` (внешний сервис) хранит SHA-256 хэш домена и ограничивает количество добавлений ссылки на устройствах. У нас домены свои, ссылки шифровать через happ-proxy.com мы **не хотим** (это завязка на их инфраструктуру + потеря контроля). InstallID **присутствует в URL подписки**, а не в заголовках, и проверяется их сервером.
- **HWID Links** — это вариант Limited Links, но "зашить HWID в ссылку". Совсем не наш кейс: мы не знаем HWID до того, как пользователь подключится, и динамически генерировать на каждое устройство свою ссылку через happ-proxy.com нерационально.
- **Provider ID** — analytics-only (раз в сутки запрос на `check.happ-proxy.com`), к серверной идентификации устройства отношения не имеет.

### 3.3. Хвост `Happ/3.20.4/Android/17782185961531805698`

**Не задокументирован** в Happ docs (подтверждено прямыми запросами к `?ask=…` к их docs). Косвенные данные:
- В Happ 3.13.0 и более ранних UA — `Happ/<version>` без хвоста (см. реверс-PHP-конвертер из сообщества: `User-Agent: Happ/3.13.0`).
- В Happ Android 3.16.0 release notes: *"Added parameter to setup user-agent parameter"*. Значит, начиная с какой-то 3.x ветки, UA стал содержать дополнительный сегмент.
- Учитывая, что Happ хранит HWID и **по дефолту шлёт его в `X-HWID`**, а ещё в UA — наиболее вероятная гипотеза: trailing token = **base10-представление HWID или его части / installation-instance-id**, который Happ дублирует в UA для бэкендов, которые читают только UA, без custom-headers.

**Важно**: **гипотеза, а не факт**. Полагаться на хвост UA как на authoritative-id мы пока не имеем права — нужен телеметрический slip-test:
- Один и тот же физический телефон до/после reinstall Happ.
- До/после reset device id (Android Reset advertising id, iOS Settings → Privacy → Reset).
- До/после обновления Happ.
- Сравнить `tail(UA)` ↔ `X-HWID`.

Если из телеметрии (Phase 0) подтвердится `tail(UA) ≡ X-HWID` хотя бы для свежих версий Happ — можно использовать как **fallback identifier** для случаев, когда `X-HWID` пользователем отключён, но он на Happ 3.x.

---

## 4. Как делают production VPN-сервисы

| Сервис / решение | Подход |
|---|---|
| **Remnawave** (production panel) | HWID Device Limit: читает `x-hwid` (обязательный) + `x-device-*` (optional). Если включено и `x-hwid` нет → `404`. Per-user override (можно отключить лимит). Отдаёт обратно `x-hwid-active`, `x-hwid-not-supported`, `x-hwid-max-devices-reached`. |
| **v2rayN / Marzban** | Не реализуют HWID-fingerprinting, есть open feature-request (`2dust/v2rayN#8532`); комьюнити пользуется Marzban-Remnawave bridge или форками. |
| **3x-ui сам по себе** | `maxConnections` per client — серверный лимит **одновременных** TCP-соединений. Это **другая** защита (не "число устройств с подпиской"), но дешёвый and-условие сверху. **Имеет смысл оставить `maxConnections = deviceLimit + 1` как hard backstop**, как и описано в вашем `DEVICE_LIMITS.md` — это вообще не задевает fingerprinting. |
| **Komаunity v2rayNG-DeviceKit-Addon** (Kotlin) | Подтверждает в open-source, что HWID/UA injection в subscription requests — отдельная фича, существует независимо от Happ. Значит, наша опора на `x-hwid` будет универсальной (не только Happ). |

---

## 5. Production-safe migration plan

Принципы:

- **Никакой destructive миграции.** Все изменения схемы — `ADD COLUMN` с `NULL`.
- **Никакой потери уже зарегистрированных устройств.** Старая `fingerprint`-логика остаётся работать **навсегда** как fallback.
- **Telemetry-first.** Сначала наблюдаем, потом меняем поведение.
- **Shadow → flag → rollout.** Новая логика сначала считается параллельно (logging-only), потом включается за `DEVICE_HWID_MATCH=true` (env), потом промотируется в default.

### Phase 0 — Telemetry only (риск: 0)

**Что меняется**: только логирование. Никаких изменений в DeviceService, никаких миграций.

В `/sub/:token` handler и в `detectAndLogDevice` добавить **extraction** (не использование):

```jsonc
// pseudo-log line
{
  "evt": "happ_identity_observation",
  "userId": "<id>",
  "subscriptionId": "<sub-id>",
  "headers_seen": {
    "x-hwid_present": true,
    "x-hwid_hash": "sha256:abcd..",           // НЕ raw hwid в логах
    "x-device-os": "Android",
    "x-ver-os": "14",
    "x-device-model": "Redmi Note 8 Pro",
    "x-device-info_present": false,
    "user-agent": "Happ/3.20.4/Android/17782185961531805698"
  },
  "ua_install_token": "17782185961531805698",  // если matched regex
  "ua_install_token_hash": "sha256:..",
  "current_canonical_fp": "7b89ed987b619c54",
  "current_fp_candidates": ["...","..."],
  "match_decision": {
    "matchStrategy": "exact|candidate|heuristic|created|limit_reached",
    "matchedDeviceId": "..."
  }
}
```

**Что получаем**:
- Покрытие `x-hwid` среди реальных пользователей Happ (Android vs iOS).
- Стабильность `tail(UA)` относительно `x-hwid` (сравнение по сессиям одного `matchedDeviceId`).
- Карта `matchedDeviceId` → set of (canonical_fp, hwid_hash, install_token_hash). Если для одного `matchedDeviceId` накапливается >1 hwid_hash → значит уже сегодня устройство видится как несколько разных в новой логике (это надо понимать заранее).

**Метрики**, которые надо собрать (хотя бы 7 дней до Phase 1):
- `% requests with x-hwid` per platform per Happ version.
- `% requests where canonical_fp changed but x-hwid stable` — это размер проблемы, которую закрывает миграция.
- `% requests where x-hwid changed but canonical_fp stable` — это размер риска (если велик — `x-hwid` нестабилен, миграция не поможет).
- Гистограмма: на одного `userId`, сколько уникальных `(x-hwid, platform)` за неделю.

### Phase 1 — Additive schema (риск: minimal)

**Миграция (safe, additive)**:

```sql
-- 1) Добавляем nullable-колонки. Никаких backfill, никаких NOT NULL.
ALTER TABLE "DeviceConfig" ADD COLUMN "hwid"           TEXT;
ALTER TABLE "DeviceConfig" ADD COLUMN "installToken"   TEXT;     -- tail(UA), пока опционально
ALTER TABLE "DeviceConfig" ADD COLUMN "osVersion"      TEXT;
ALTER TABLE "DeviceConfig" ADD COLUMN "userAgentRaw"   TEXT;     -- последний UA для дебага
ALTER TABLE "DeviceConfig" ADD COLUMN "identitySchema" TEXT;     -- 'legacy' | 'happ_v1' | 'happ_v2'
ALTER TABLE "DeviceConfig" ADD COLUMN "hwidFirstSeenAt" DATETIME;
ALTER TABLE "DeviceConfig" ADD COLUMN "hwidLastSeenAt"  DATETIME;

-- 2) Partial unique indexes (SQLite supports WHERE-clause indexes).
CREATE UNIQUE INDEX "DeviceConfig_userId_hwid_uniq"
  ON "DeviceConfig"("userId", "hwid")
  WHERE "hwid" IS NOT NULL;

CREATE INDEX "DeviceConfig_userId_installToken_idx"
  ON "DeviceConfig"("userId", "installToken")
  WHERE "installToken" IS NOT NULL;
```

**Prisma schema diff** (ориентир, не финал):

```prisma
model DeviceConfig {
  // ... существующие поля без изменений ...

  hwid             String?
  installToken     String?
  osVersion        String?
  userAgentRaw     String?
  identitySchema   String?   // "legacy" | "happ_v1" (X-HWID) | "happ_v2" (UA tail)
  hwidFirstSeenAt  DateTime?
  hwidLastSeenAt   DateTime?

  // существующий уникальный индекс остаётся:
  @@unique([userId, fingerprint])
  @@index([userId, lastSeenAt])
  // новый partial unique index создаётся через raw migration выше.
}
```

**На этом этапе deviceService.ts НЕ менять.** Никакой записи в новые колонки ещё нет — индексы лежат пустыми.

### Phase 2 — Shadow matching (риск: 0 — нет влияния на ответ)

В `DeviceService.registerDevice`:

```ts
// Внутри транзакции, ПЕРЕД return-ом обычного matchResult'а:
const happHeaders = parseHappHeaders(rawHeaders);            // new util
const uaInstallToken = extractHappUaInstallToken(rawUA);     // new util

const shadow = await this.computeShadowMatch(tx, userId, devices, {
  hwid:           happHeaders.hwid ?? null,
  installToken:   uaInstallToken ?? null,
  platform:       deviceInfo.platform,
  fallbackFp:     deviceInfo.fingerprint,
  fpCandidates:   deviceInfo.fingerprintCandidates,
});

// 100% non-destructive: только пишем структурированный log.
this.logger?.info({
  evt: "device_match_shadow",
  current:  { strategy: actualResult.matchStrategy, id: actualResult.matchedDeviceId },
  shadow:   shadow,
  diff:     shadow.matchedDeviceId !== actualResult.matchedDeviceId,
}, "shadow match diff");
```

`computeShadowMatch` — pure-function, использует следующий приоритет:

1. **Strong-identity HWID**: device.hwid === incoming.hwid → match.
2. **Install-token**: device.installToken === incoming.installToken → match.
3. **Legacy** (canonical fp / candidate fp) → match.
4. **Heuristic** (как сейчас) → match.
5. else → new.

**Целевые метрики Phase 2** (наблюдать 1–2 недели):
- `shadow_diff_rate` = доля запросов, где shadow и current расходятся.
- Из них — сколько `shadow=match, current=new` (новая логика спасла бы слот).
- Из них — сколько `shadow=new, current=match` (новая логика создала бы лишний слот). Если этот сегмент существенный — стоп, не промотируем.

### Phase 3 — Promote behind feature flag (риск: контролируемый)

**Env flag**: `DEVICE_HWID_MATCH=true` (default off; включаем сначала на dev/canary, потом всем).

В `registerDevice`, когда флаг `on`:

1. Если у incoming есть `hwid` И есть **существующий device с тем же `hwid`** → **это authoritative match**, поверх любых fingerprint-сравнений.
   - При первом таком матче: записать `hwidFirstSeenAt = now`, `identitySchema = 'happ_v1'`, обновить `userAgentRaw`, `osVersion`, `installToken`.
2. Если у incoming есть `hwid`, и в DeviceConfig для этого `userId` **нет ни одного** с `hwid`, но **есть** device, у которого:
   - совпадает `platform`, И
   - `device.fingerprint ∈ incoming.fingerprintCandidates` (либо `=== incoming.canonical_fp`),
   тогда **"adopt"** этого device: записать ему `hwid = incoming.hwid` + остальные новые поля. Это однократный upgrade. Никогда не удаляем чужое устройство.
3. Если у incoming есть `hwid`, и **уже существует device с другим `hwid`**, и кандидат-fingerprint матчит этот другой device → **conflict**, лог + предпочитаем match по hwid (новая запись), но НЕ перетираем чужой `hwid` (только обновляем lastSeenAt и подтягиваем UA).
4. Если у incoming **нет** `hwid` (Happ выключен / другой клиент):
   - Сначала пробуем матч по `installToken` (если есть и совпадает с device.installToken — но **только** в пределах same `platform`).
   - Дальше — текущая legacy-логика: exact / candidate / heuristic / weak.
5. **Никогда** не переписываем существующий `device.hwid` слабым сигналом (отсутствие x-hwid не должен затирать сохранённый).

**Что меняется в сценарии из задачи (Redmi Note 8 Pro, Happ Android)**:
- Запрос 1 (model=Redmi) + `X-HWID=abc123` → создаём device A с `fingerprint=strong(Redmi)`, `hwid=abc123`.
- Запрос 2 (model=Unknown) + `X-HWID=abc123` → **прямой hwid match** → A, никакого нового слота. **Никакого heuristic — это просто exact match по hwid.**

### Phase 4 — Hardening (риск: 0, чисто cleanup)

Когда доля устройств с непустым `hwid` достигнет, скажем, **70% активных**:

- В `findWeakPlatformMatch` и `findHeuristicMatch` запретить "съедание" устройств **с непустым hwid** запросами без hwid (или с другим hwid). Это и есть защита от того, что pkid реального устройства "оторвётся" и съест чей-то слот.
- В collapse-логике: устройства с разным `hwid` **никогда** не схлопывать.
- Метрика slot-churn должна упасть.

---

## 6. Что можно и нужно оставить как есть

1. **`Subscription.deviceLimit` как source of truth** — фикс DEVICE_SLOT bug правильный, не трогаем.
2. **`preserveFingerprint=true` при weak/heuristic-матче** — правильный фикс, не трогаем.
3. **`@@unique([userId, fingerprint])`** — оставляем (для legacy-устройств; новые устройства будут дополнительно уникальны по `(userId, hwid)`).
4. **3x-ui интеграция и `xuiClientUuid`** — вообще ортогонально.
5. **`/sub/:token` ответ при LIMIT_REACHED** (empty body + announce) — текущее поведение лучше 403; оставляем.
6. **`fingerprintCandidates`** — оставляем как backward-compat для старых записей.
7. **`detectAndLogDevice`** — оставляем; **расширяем** новой функцией `parseHappHeaders` (отдельная, не ломаем сигнатуру существующей).

---

## 7. Минимальный набор изменений (когда наступит время делать PR)

Только перечисление, не код:

1. `src/utils/deviceDetect.ts`
   - `parseHappHeaders(headers): { hwid, deviceOs, osVersion, deviceModel, deviceLocale, deviceInfo }` — все поля nullable, заголовки нормализованы (lowercase, trim, длина ≤ 256).
   - `extractHappUaInstallToken(ua): string | null` — regex `/^Happ\/[^/]+\/[^/]+\/(\S+)$/i`, ограничить charset/длину.
   - DeviceInfo получает дополнительные nullable-поля: `hwid`, `installToken`, `osVersion`, `deviceModelFromHeader`. **Не менять текущий fingerprint-расчёт.**

2. `src/http/subscription.ts`
   - В `/sub/:token` после `detectAndLogDevice` собрать `happHeaders` и `installToken`, добавить их в `req.log.info(registrationLog, ...)`.
   - **Никакого изменения логики ответа на этой фазе (Phase 0).**

3. `src/modules/devices/deviceService.ts`
   - **Phase 0**: ничего, кроме приёма расширенного `DeviceInfo` и проброса в лог.
   - **Phase 2** (отдельный PR): `computeShadowMatch` (pure function) + shadow-log.
   - **Phase 3** (отдельный PR, **за flag**): `findHwidMatch`, `findInstallTokenMatch`, `adoptDeviceWithHwid`.

4. `prisma/schema.prisma` + new migration **(Phase 1)**:
   - Добавить nullable поля и partial unique index (см. SQL выше).
   - **Никаких backfill миграций.**

5. **Bonus (не часть device-fingerprinting)** — отдельный mini-PR: починить mojibake в `deviceService.ts` (строки 82, 150, 276, 301). Текст ошибок сейчас выглядит у пользователей как `РџРѕРґРїРёСЃРєР° РёСЃС‚РµРєР»Р°...`.

---

## 8. Telemetry / logs / metrics — что мониторить

**Структурированные log-поля** (на каждый `/sub/:token` с активной подпиской):

| Поле | Назначение |
|---|---|
| `userId`, `subscriptionId` | базовое |
| `platform`, `model`, `osVersion` | классификация |
| `happ_version` (parsed из UA) | сегментация по версиям Happ |
| `has_x_hwid` (bool), `has_x_device_info` (bool) | coverage HWID-фичи |
| `hwid_hash` (sha256), `install_token_hash` (sha256) | privacy-safe ID для агрегатов |
| `canonical_fp`, `fp_candidate_count` | существующая логика |
| `match_strategy`, `matched_device_id`, `collapsed_duplicates` | результат |
| `shadow_match_strategy`, `shadow_matched_device_id` | новая логика (Phase 2+) |
| `shadow_diff` (bool) | агрегируемая метрика |
| `current_devices`, `total_limit` | контекст |

**Метрики (Prometheus / любой агрегатор по логам)**:

- `device_register_total{strategy, platform, has_hwid}` — counter.
- `device_register_limit_reached_total{platform, has_hwid}` — counter (это и есть жалоба «лимит достигнут»).
- `shadow_match_diff_total{kind}` где `kind ∈ {saved_slot, would_create_extra, neutral}`.
- `hwid_coverage_ratio{platform}` — gauge, на момент последних N запросов.
- `slot_churn_per_user{percentile}` — за окно 24h, сколько разных DeviceConfig для одного пользователя.

**Alert-условия** (грубо):
- `device_register_limit_reached_total / device_register_total > 5%` в течение 1ч → page (что-то с матчингом).
- В Phase 2: `shadow_diff_total{kind=would_create_extra} > 1%` → стоп rollout, расследовать.
- В Phase 3: рост `device_register_limit_reached_total{has_hwid=true}` после включения флага → откат флага.

---

## 9. Что я бы попросил у вас перед Phase 1 PR

Чтобы Phase 0 telemetry дал нужный результат за минимальное время, я бы попросил:

1. **2–3 анонимизированных production-лога** `/sub/:token` (включая заголовки) для одного и того же физического Happ-устройства, разнесённых по времени (через час, через день). Нужно увидеть стабильность `X-HWID` и `tail(UA)`.
2. Подтвердить, есть ли уже сегодня сборщик логов (Loki / Elastic / просто stdout + journalctl) — это определит, насколько быстро Phase 0 даст ответы.
3. Текущая статистика: сколько уникальных `DeviceConfig.fingerprint` в среднем на одного активного пользователя за 7 дней. Если медиана > `deviceLimit`, это и есть размер боли в цифрах — отличная отправная точка.

После этого можно делать PR Phase 1 (миграция + новые util-функции + расширенный лог) — он минимальный, **не меняет ни одного user-facing поведения**, мержится безопасно.

---

## 10. Чего категорически НЕ делаем

- ❌ Не переходим на `happ-proxy.com` Limited Links / HWID Links (внешняя зависимость, потеря контроля, и это про другую фичу).
- ❌ Не вводим жёсткое требование `x-hwid` (Remnawave-style 404). Часть пользователей выключила Send HWID в настройках Happ.
- ❌ Не делаем `DROP COLUMN fingerprint` или переименование. Никогда. Это **навсегда** legacy-ключ.
- ❌ Не делаем `UPDATE DeviceConfig SET fingerprint = ...` batch-миграцию. Каждое обновление fingerprint — только через `registerDevice` живым трафиком.
- ❌ Не доверяем `tail(UA)` как primary identity до подтверждения телеметрией.
- ❌ Не переписываем deviceService с нуля. Эволюция, не революция.

---

## Источники

- Happ Privacy Policy — https://www.happ.su/main/privacy-policy
- Happ Provider ID docs — https://www.happ.su/happ/dev-docs/provider-id
- Happ Limited Links — https://docs.happ-proxy.com/getting-started/quickstart
- Happ HWID Links — https://www.happ.su/main/dev-docs/hwid-links
- Happ App management (User-Agent override) — https://www.happ.su/main/dev-docs/app-management
- Happ Android 1.16.0 release (X-HWID / X-Device-Info) — https://newreleases.io/project/github/Happ-proxy/happ-android/release/1.16.0
- Happ Android 3.16.0 release (UA override) — https://github.com/Happ-proxy/happ-android/releases/tag/3.16.0
- Remnawave HWID Device Limit — https://remna.st/docs/features/hwid-device-limit
- v2rayN feature request #8532 (HWID transmission) — https://github.com/2dust/v2rayN/issues/8532
- Community Happ reverse — https://gist.github.com/bubasik/af37247b71ca0b253161b48614aba61a
- v2rayNG-DeviceKit-Addon (HWID/UA в subscription requests) — https://github.com/lolka1333/v2rayNG-DeviceKit-Addon
