import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { URL } from "node:url";
import type { ThreeXUiService } from "../integrations/threeXui/threeXuiService";
import type { SubscriptionService } from "../modules/subscription/subscriptionService";
import type { DeviceService } from "../modules/devices/deviceService";
import { buildSubscription } from "../modules/subscription/subscriptionBuilder";
import { qrSvg } from "./qr";
import { detectAndLogDevice } from "../utils/deviceDetect";

function hostnameFromUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.hostname;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson<T>(value: T): string {
  // Prevent `</script>`-style breakouts.
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function formatDateRu(date: Date): string {
  // dd.mm.yyyy
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}.${mm}.${yyyy}`;
}

export async function registerSubscriptionRoutes(
  app: FastifyInstance,
  deps: Readonly<{
    prisma: PrismaClient;
    subscriptions: SubscriptionService;
    xui: ThreeXUiService;
    devices: DeviceService;
    backendPublicUrl: string;
    telegramBotUrl: string;
    fastServerUrls: ReadonlyArray<{ displayName: string; configUrl: string }>;
    mobileBypassUrls: ReadonlyArray<string>;
    xuiInboundId: number;
    xuiClientFlow?: string;
  }>,
): Promise<void> {
  const backendPublicOrigin = (() => {
    try {
      return new URL(deps.backendPublicUrl).origin;
    } catch {
      return deps.backendPublicUrl.replace(/\/+$/, "");
    }
  })();

  const publicOriginFromRequest = (req: any): string => {
    const header = (name: string): string | undefined => {
      const value = req.headers?.[name];
      if (typeof value === "string" && value.trim().length) return value.trim();
      if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim().length) return value[0].trim();
      return undefined;
    };

    const protoRaw = header("x-forwarded-proto");
    const hostRaw = header("x-forwarded-host") ?? header("host");
    const proto = protoRaw ? protoRaw.split(",")[0]!.trim().toLowerCase() : undefined;
    const host = hostRaw ? hostRaw.split(",")[0]!.trim() : undefined;

    if (!proto || !host) return backendPublicOrigin;
    if (proto !== "https" && proto !== "http") return backendPublicOrigin;
    if (!host.length || /\s/.test(host)) return backendPublicOrigin;

    try {
      // eslint-disable-next-line no-new
      new URL(`${proto}://${host}`);
      return `${proto}://${host}`;
    } catch {
      return backendPublicOrigin;
    }
  };

  app.get<{ Params: { token: string } }>("/connect/:token", async (req, reply) => {
    const token = String(req.params.token ?? "").trim();
    if (!token) return await reply.code(400).type("text/plain; charset=utf-8").send("Bad request\n");

    // Request Client Hints for better device detection on Android 10+
    // Critical-CH forces browser to retry request with hints immediately
    reply.header("Accept-CH", "Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version");
    reply.header("Critical-CH", "Sec-CH-UA-Model");

    // Log device info for testing (supports Client Hints + IP-based fingerprint)
    const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")?.[0]?.trim() ?? req.ip;
    detectAndLogDevice(req.headers as Record<string, string | undefined>, `/connect/${token}`, clientIp);

    const publicOrigin = publicOriginFromRequest(req);
    const baseSubUrl = `${publicOrigin.replace(/\/+$/, "")}/sub/${encodeURIComponent(token)}`;

    try {
      let row: (import("@prisma/client").Subscription & { user: import("@prisma/client").User }) | null = null;
      try {
        row = await deps.prisma.subscription.findUnique({
          where: { xuiSubscriptionId: token },
          include: { user: true },
        });
      } catch (err: any) {
        req.log.warn({ err }, "Initial findUnique failed, attempting fallback (likely missing DB column)");
        // Fallback: fetch subscription and user separately, skipping extraDeviceSlots
        const sub = await deps.prisma.subscription.findUnique({
          where: { xuiSubscriptionId: token },
        });
        if (sub) {
          const user = await deps.prisma.user.findUnique({
            where: { id: sub.userId },
            select: {
              id: true,
              telegramId: true,
              createdAt: true,
              updatedAt: true,
              referralCode: true,
              // Select only essential fields to avoid "column not found" error
            },
          });
          if (user) {
            // Mock missing fields to satisfy type
            row = {
              ...sub,
              user: {
                ...user,
                extraDeviceSlots: 0,
                trialGrantedAt: null,
                offerAcceptedAt: null,
                offerVersion: null,
                lastPromoActivatedAt: null,
                referredById: null,
              } as any,
            };
          }
        }
      }

      if (!row) {
        const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>LisVPN — Подключение</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Apple Color Emoji","Segoe UI Emoji"; background: radial-gradient(1200px 800px at 20% -10%, rgba(0, 209, 255, 0.18), transparent 55%), radial-gradient(900px 600px at 90% 0%, rgba(255, 170, 0, 0.12), transparent 45%), #0b0f14; color: #e7edf4; }
      .wrap { max-width: 920px; margin: 0 auto; padding: 28px 16px 48px; }
      .card { background: rgba(16, 22, 31, 0.72); border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; padding: 18px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); backdrop-filter: blur(10px); }
      .top { display:flex; align-items:center; justify-content:space-between; margin-bottom: 18px; }
      .brand { display:flex; gap: 10px; align-items:center; font-weight: 700; letter-spacing: 0.2px; }
      .brand .logo { width: 38px; height: 38px; border-radius: 12px; display:grid; place-items:center; background: rgba(255, 170, 0, 0.12); border: 1px solid rgba(255,255,255,0.10); }
      .hint { color: rgba(231,237,244,0.72); font-size: 14px; line-height: 1.5; margin-top: 10px; }
      .err { display:flex; flex-direction:column; gap: 10px; }
      .title { font-size: 18px; font-weight: 700; }
      .btn { appearance:none; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: #e7edf4; border-radius: 12px; padding: 10px 12px; font-weight: 600; cursor: pointer; }
      .btn:active { transform: translateY(1px); }
      .row { display:flex; gap: 10px; flex-wrap:wrap; margin-top: 14px; }
      .input { width: 100%; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color: #e7edf4; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="brand">
          <div class="logo">🦊</div>
          <div>LisVPN</div>
        </div>
      </div>
      <div class="card err">
        <div class="title">Ссылка устарела</div>
        <div class="hint">Похоже, токен подписки больше не действует. Запросите новую ссылку в Telegram-боте.</div>
        <div class="row">
          <button class="btn" id="copyBtn" type="button">Скопировать ссылку подписки</button>
        </div>
        <div class="hint">Ссылка:</div>
        <input class="input" readonly value="${escapeHtml(baseSubUrl)}" />
      </div>
    </div>
    <script>
      (function () {
        const url = ${safeJson(baseSubUrl)};
        const btn = document.getElementById('copyBtn');
        btn?.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(url); btn.textContent = 'Скопировано'; setTimeout(() => btn.textContent = 'Скопировать ссылку подписки', 1200); }
          catch { prompt('Скопируйте ссылку:', url); }
        });
      })();
    </script>
  </body>
</html>`;
        return await reply
          .header("Cache-Control", "no-store")
          .type("text/html; charset=utf-8")
          .code(200)
          .send(html);
      }

      // Avoid hitting 3x-ui on every page open, but do sync when we likely need it.
      const nowMs = Date.now();
      const paidUntilMs = row.paidUntil?.getTime() ?? 0;
      const expiresMs = row.expiresAt?.getTime() ?? 0;
      const needsExtend = paidUntilMs > nowMs && (expiresMs === 0 || expiresMs < paidUntilMs);
      const lastSyncMs = row.lastSyncedAt?.getTime() ?? 0;
      const tooOld = lastSyncMs === 0 || nowMs - lastSyncMs > 2 * 60 * 1000;

      const state =
        needsExtend || tooOld
          ? await deps.subscriptions.syncFromXui(row.user).catch((err) => {
            req.log.error({ err }, "syncFromXui failed for /connect/:token");
            return { subscription: row, expiresAt: row.expiresAt ?? undefined, enabled: row.enabled };
          })
          : { subscription: row, expiresAt: row.expiresAt ?? undefined, enabled: row.enabled };

      const effectiveExpiresAt =
        state.expiresAt && state.subscription.paidUntil
          ? (state.expiresAt.getTime() > state.subscription.paidUntil.getTime() ? state.expiresAt : state.subscription.paidUntil)
          : (state.expiresAt ?? state.subscription.paidUntil ?? undefined);

      const isActive = !!effectiveExpiresAt && effectiveExpiresAt.getTime() > nowMs && state.enabled;

      // Register or update device (but don't block page load on errors)
      const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")?.[0]?.trim() ?? req.ip;
      const deviceInfo = detectAndLogDevice(req.headers as Record<string, string | undefined>, `/connect/${token}`, clientIp);

      let deviceError: string | undefined;
      /* 
         TODO: Re-enable device limits after confirming DB migration is applied.
         Currently disabled to prevent crashes on missing DeviceConfig table/columns.
      
      if (deviceInfo.fingerprint) {
        const registerResult = await deps.devices.registerDevice(row.user.id, deviceInfo, isActive).catch((err) => {
          req.log.error({ err }, "Failed to register device");
          return { success: false, error: "Ошибка регистрации устройства" };
        });

        if (!registerResult.success && "errorCode" in registerResult && registerResult.errorCode === "LIMIT_REACHED") {
          deviceError = registerResult.error;
        }
      }
      */

      const userLabel = `user_${row.user.telegramId}`;
      const expiresLabel = effectiveExpiresAt ? formatDateRu(effectiveExpiresAt) : "—";

      const html = `<!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0" />
    <meta name="color-scheme" content="dark" />
    <title>LisVPN — Подключение</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0f1115;
            --card-bg: rgba(23, 27, 34, 0.7);
            --card-border: rgba(255, 255, 255, 0.08);
            --primary: #0088cc;
            --primary-glow: rgba(0, 136, 204, 0.3);
            --accent: #22d3ee;
            --accent-glow: rgba(34, 211, 238, 0.2);
            --success: #34d399;
            --text-main: #ffffff;
            --text-muted: #9ca3af;
            --font-main: 'Inter', system-ui, -apple-system, sans-serif;
            --radius-L: 24px;
            --radius-M: 16px;
            --radius-S: 12px;
        }

        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        
        body {
            margin: 0;
            background-color: var(--bg-color);
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(0, 136, 204, 0.15) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(34, 211, 238, 0.1) 0%, transparent 40%);
            color: var(--text-main);
            font-family: var(--font-main);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px;
        }

        .container {
            width: 100%;
            max-width: 500px;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 10px;
            padding: 0 4px;
        }
        .logo {
            width: 42px;
            height: 42px;
            background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02));
            border: 1px solid var(--card-border);
            border-radius: var(--radius-S);
            display: grid;
            place-items: center;
            font-size: 24px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .brand-name {
            font-size: 20px;
            font-weight: 700;
            letter-spacing: -0.02em;
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: var(--radius-L);
            padding: 24px;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            box-shadow: 0 4px 24px rgba(0,0,0,0.2);
        }

        .status-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .status-label {
            font-size: 14px;
            color: var(--text-muted);
            font-weight: 500;
        }
        .status-badge {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 20px;
            background: rgba(52, 211, 153, 0.15);
            color: var(--success);
            font-size: 13px;
            font-weight: 600;
            border: 1px solid rgba(52, 211, 153, 0.2);
        }
        .status-badge.inactive {
             background: rgba(239, 68, 68, 0.15);
             color: #ef4444;
             border-color: rgba(239, 68, 68, 0.2);
        }

        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }
        .info-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .info-key {
            font-size: 12px;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            font-weight: 600;
        }
        .info-value {
            font-size: 15px;
            font-weight: 600;
        }

        .tabs {
            display: grid;
            grid-template-columns: 1fr 1fr;
            background: rgba(0,0,0,0.2);
            padding: 4px;
            border-radius: var(--radius-M);
            border: 1px solid var(--card-border);
            margin-bottom: 16px;
        }
        .tab-btn {
            background: transparent;
            border: none;
            color: var(--text-muted);
            padding: 10px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            border-radius: var(--radius-S);
            transition: all 0.2s ease;
            font-family: inherit;
        }
        .tab-btn.active {
            background: rgba(255,255,255,0.1);
            color: var(--text-main);
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }

        .section-title {
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 12px;
            padding-left: 4px;
        }
        
        .app-option {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: var(--radius-M);
            padding: 16px;
            margin-bottom: 12px;
            cursor: pointer;
            transition: border-color 0.2s;
        }
        .app-option:hover, .app-option.selected {
            border-color: var(--accent);
            background: rgba(34, 211, 238, 0.05);
        }
        .app-info {
            display: flex;
            flex-direction: column;
        }
        .app-name {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 2px;
        }
        .app-desc {
            font-size: 13px;
            color: var(--text-muted);
        }
        .radio-circle {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            border: 2px solid var(--card-border);
            display: grid;
            place-items: center;
        }
        .app-option.selected .radio-circle {
            border-color: var(--accent);
        }
        .app-option.selected .radio-circle::after {
            content: '';
            width: 10px;
            height: 10px;
            background: var(--accent);
            border-radius: 50%;
        }

        .step-list {
            display: flex;
            flex-direction: column;
            gap: 16px;
            margin-top: 24px;
        }
        .step {
            display: flex;
            gap: 16px;
        }
        .step-num {
            width: 28px;
            height: 28px;
            background: rgba(255,255,255,0.06);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            display: grid;
            place-items: center;
            font-weight: 700;
            font-size: 14px;
            flex-shrink: 0;
            color: var(--accent);
        }
        .step-content {
            flex: 1;
        }
        .step-title {
            font-weight: 600;
            font-size: 15px;
            margin-bottom: 4px;
        }
        .step-desc {
            font-size: 13px;
            color: var(--text-muted);
            line-height: 1.5;
        }
        
        .main-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            width: 100%;
            background: linear-gradient(135deg, #0088cc 0%, #00aaff 100%);
            color: white;
            border: none;
            padding: 16px;
            border-radius: var(--radius-M);
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            text-decoration: none;
            box-shadow: 0 4px 20px rgba(0, 136, 204, 0.4);
            transition: transform 0.1s;
            margin-top: 8px;
            font-family: inherit;
        }
        .main-btn:active {
            transform: scale(0.98);
        }

        .secondary-actions {
            display: flex;
            gap: 12px;
            margin-top: 16px;
        }
        .sec-btn {
            flex: 1;
            background: rgba(255,255,255,0.05);
            border: 1px solid var(--card-border);
            color: var(--text-main);
            padding: 12px;
            border-radius: var(--radius-M);
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            font-family: inherit;
        }
        
        .toast {
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%) translateY(20px);
            background: #1f2937;
            border: 1px solid var(--card-border);
            color: white;
            padding: 12px 24px;
            border-radius: 50px;
            font-size: 14px;
            font-weight: 600;
            opacity: 0;
            pointer-events: none;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
            z-index: 100;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .toast.visible {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }

        .manual-box {
            display: none;
            background: rgba(0,0,0,0.3);
            border-radius: var(--radius-S);
            padding: 12px;
            margin-top: 12px;
            position: relative;
        }
        .manual-box.visible { display: block; }
        .key-text {
            word-break: break-all;
            font-family: 'SF Mono', 'Roboto Mono', monospace;
            font-size: 12px;
            color: var(--text-muted);
            max-height: 60px;
            overflow-y: hidden;
            mask-image: linear-gradient(to bottom, black 50%, transparent 100%);
        }

        @media (min-width: 600px) {
            .container { max-width: 600px; }
            .card { padding: 32px; }
        }
    </style>
</head>
<body>

<div class="container">
    <div class="header">
        <div class="logo">🦊</div>
        <div class="brand-name">LisVPN</div>
    </div>

    ${deviceError ? `
    <!-- Device Limit Warning -->
    <div class="card" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.3);">
        <div style="display: flex; align-items: start; gap: 12px;">
            <div style="font-size: 24px; flex-shrink: 0;">⚠️</div>
            <div>
                <div style="font-weight: 700; font-size: 16px; margin-bottom: 6px;">Превышен лимит устройств</div>
                <div style="font-size: 14px; color: var(--text-muted); line-height: 1.6;">
                    ${escapeHtml(deviceError)}
                    <br /><br />
                    Управляйте устройствами в боте: <a href="${escapeHtml(deps.telegramBotUrl)}" style="color: var(--accent);">@LisVPN_bot</a>
                </div>
            </div>
        </div>
    </div>
    ` : ''}

    <!-- Status Card -->
    <div class="card">
        <div class="status-header">
            <span class="status-label">Статус подписки</span>
            <div class="status-badge ${isActive ? '' : 'inactive'}">
                <span>●</span> ${isActive ? 'Активна' : 'Не активна'}
            </div>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <span class="info-key">Пользователь</span>
                <span class="info-value">${escapeHtml(userLabel)}</span>
            </div>
            <div class="info-item">
                <span class="info-key">Истекает</span>
                <span class="info-value">${escapeHtml(expiresLabel)}</span>
            </div>
        </div>
    </div>

    <div class="section-title">Настройка</div>

    <!-- Platform Tabs -->
    <div class="tabs">
        <button class="tab-btn active" id="tab-android" onclick="switchPlatform('android')">Android / Windows</button>
        <button class="tab-btn" id="tab-ios" onclick="switchPlatform('ios')">iOS / macOS</button>
    </div>

    <!-- App Selection Logic (Dynamic) -->
    <div id="apps-container"></div>

    <!-- Steps -->
    <div class="card" style="padding: 20px;">
        <div class="step-list" id="steps-container"></div>
        
        <div id="action-area" style="margin-top: 24px;">
            <a href="#" class="main-btn" id="main-connect-btn">
                <span style="font-size: 20px">⚡</span> Подключить
            </a>
        </div>

        <div class="secondary-actions">
            <button class="sec-btn" onclick="copyLink()">
                <svg width="16" height="16" fill="none" class="icon"><path d="M5.5 11.5c-.88 0-1.63-.35-2.12-.92A2.96 2.96 0 0 1 2.5 8.5c0-.9.37-1.7 1-2.26.63-.56 1.5-.9 2.5-.9h3v1.5h-3c-1 0-1.5.8-1.5 1.66 0 .86.5 1.66 1.5 1.66h2v1.34h-2Zm5-7c.9 0 1.64.35 2.13.92.62.74.87 1.68.87 2.08 0 .9-.38 1.7-1 2.26-.63.56-1.5.9-2.5.9h-3V9.16h3c1 0 1.5-.8 1.5-1.66 0-.86-.5-1.66-1.5-1.66h-2V4.5h2Zm-5 4.34h8v-1.5h-8v1.5Z" fill="currentColor"/></svg>
                Копировать
            </button>
            <button class="sec-btn" onclick="toggleManual()">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Ручная
            </button>
        </div>
        
        <div class="manual-box" id="manual-box">
             <div class="key-text" id="manual-key">${escapeHtml(baseSubUrl)}</div>
             <button class="sec-btn" onclick="copyLink()" style="width:100%; margin-top:8px;">Скопировать весь ключ</button>
        </div>
    </div>
</div>

<div class="toast" id="toast">
    <span style="font-size: 18px">✅</span>
    <span>Ссылка скопирована!</span>
</div>

<script>
    // Constants
    const SUB_URL = ${safeJson(baseSubUrl)}; 
    
    // State
    let currentPlatform = 'android';
    let currentApp = 'hiddify';

    // Data
    const APPS = {
        android: [
            { id: 'happ', name: 'Happ', desc: 'Простой и удобный клиент', link: 'happ://add/' },
            { id: 'hiddify', name: 'Hiddify', desc: 'Рекомендуемое. Красивый и простой', link: 'hiddify://install-config?url=' },
            { id: 'v2rayng', name: 'v2RayNG', desc: 'Классический клиент, надежный', link: 'v2rayng://install-config?url=' }
        ],
        ios: [
            { id: 'streisand', name: 'Streisand', desc: 'Отличный дизайн, бесплатно', link: 'streisand://import/' },
            { id: 'v2box', name: 'V2Box', desc: 'Популярный выбор', link: 'v2box://install-sub?url=' }
        ]
    };

    const STEPS = {
        happ: [
            "Установите Happ",
            "Нажмите «Подключить» ниже",
            "Приложение откроется и добавит подписку"
        ],
        hiddify: [
            "Установите Hiddify из Google Play / AppStore",
            "Нажмите кнопку «Подключить» ниже",
            "В приложении нажмите большую кнопку Старт"
        ],
        v2rayng: [
            "Скачайте v2RayNG",
            "Скопируйте ключ подписки",
            "В приложении нажмите + -> Импорт из буфера"
        ],
        streisand: [
            "Скачайте Streisand",
            "Нажмите «Подключить» ниже",
            "Разрешите добавление конфигурации VPN"
        ],
        v2box: [
            "Установите V2Box",
            "Скопируйте ключ",
            "Оно само все сделает"
        ]
    };

    // Init
    function init() {
        // Detect OS simply
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('macintosh')) {
            currentPlatform = 'ios';
        }
        
        switchPlatform(currentPlatform);
    }

    function switchPlatform(p) {
        currentPlatform = p;
        // Update tabs
        document.getElementById('tab-android').classList.toggle('active', p === 'android');
        document.getElementById('tab-ios').classList.toggle('active', p === 'ios');
        
        // Default app for platform
        currentApp = APPS[p][0].id;
        
        renderApps();
        renderSteps();
    }
    
    // expose to window for onclick
    window.switchPlatform = switchPlatform;
    
    function selectApp(appId) {
        currentApp = appId;
        renderApps();
        renderSteps();
    }
    window.selectApp = selectApp;

    function renderApps() {
        const container = document.getElementById('apps-container');
        const list = APPS[currentPlatform];
        
        container.innerHTML = list.map(app => 
            '<div class=\"app-option ' + (currentApp === app.id ? 'selected' : '') + '\" onclick=\"selectApp(\\'' + app.id + '\\')\">' +
            '    <div class=\"app-info\">' +
            '        <span class=\"app-name\">' + app.name + '</span>' +
            '        <span class=\"app-desc\">' + app.desc + '</span>' +
            '    </div>' +
            '    <div class=\"radio-circle\"></div>' +
            '</div>'
        ).join('');
    }

    function renderSteps() {
        const container = document.getElementById('steps-container');
        const steps = STEPS[currentApp] || ["Скачать", "Подключить", "Радоваться"];
        
        container.innerHTML = steps.map((text, i) => 
            '<div class=\"step\">' +
            '    <div class=\"step-num\">' + (i + 1) + '</div>' +
            '    <div class=\"step-content\">' +
            '        <div class=\"step-title\">' + text + '</div>' +
            '        <div class=\"step-desc\">Следуйте инструкции на экране.</div>' +
            '    </div>' +
            '</div>'
        ).join('');

        // Update button link
        const currentAppData = APPS[currentPlatform].find(a => a.id === currentApp);
        const link = currentAppData ? (currentAppData.link + SUB_URL) : '#';
        const btn = document.getElementById('main-connect-btn');
        btn.href = link;
        
         if (currentApp === 'v2raytun' || currentApp === 'streisand' || currentApp === 'v2box') {
             btn.href = currentAppData.link + encodeURIComponent(SUB_URL);
        } else {
             btn.href = currentAppData.link + SUB_URL;
        }
    }

    function copyLink() {
        navigator.clipboard.writeText(SUB_URL).then(() => {
            const t = document.getElementById('toast');
            t.classList.add('visible');
            setTimeout(() => t.classList.remove('visible'), 2000);
        });
    }
    window.copyLink = copyLink;

    function toggleManual() {
        document.getElementById('manual-box').classList.toggle('visible');
    }
    window.toggleManual = toggleManual;

    // Run
    init();

</script>
</body>
</html>`;

      return await reply
        .header("Cache-Control", "no-store")
        .type("text/html; charset=utf-8")
        .code(200)
        .send(html);
    } catch (err) {
      req.log.error({ err }, "GET /connect/:token failed");
      return await reply
        .header("Cache-Control", "no-store")
        .type("text/plain; charset=utf-8")
        .code(500)
        .send("Internal server error\n");
    }
  });

  app.get<{ Params: { token: string } }>("/sub/:token", async (req, reply) => {
    const replyExpired = async (prependText?: string): Promise<void> => {
      const built = buildSubscription(
        { enabled: false, expiresAt: null, telegramBotUrl: deps.telegramBotUrl },
        { primaryServer: null, mobileBypassUrls: [] },
      );
      for (const [key, value] of Object.entries(built.headers)) reply.header(key, value);
      const body = prependText?.trim().length ? `${prependText.trim()}\n\n${built.body}` : built.body;
      await reply.code(200).send(body);
    };

    const token = String(req.params.token ?? "").trim();
    if (!token) return await reply.code(400).type("text/plain; charset=utf-8").send("Bad request\n");

    // Request Client Hints for better device detection on Android 10+
    reply.header("Accept-CH", "Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version");

    // Get client IP for device fingerprinting
    const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")?.[0]?.trim() ?? req.ip;

    try {
      let row: (import("@prisma/client").Subscription & { user: import("@prisma/client").User }) | null = null;
      try {
        row = await deps.prisma.subscription.findUnique({
          where: { xuiSubscriptionId: token },
          include: { user: true },
        });
      } catch (err: any) {
        req.log.warn({ err }, "Initial findUnique in /sub failed, attempting fallback");
        const sub = await deps.prisma.subscription.findUnique({
          where: { xuiSubscriptionId: token },
        });
        if (sub) {
          const user = await deps.prisma.user.findUnique({
            where: { id: sub.userId },
            select: {
              id: true,
              telegramId: true,
              createdAt: true,
              updatedAt: true,
              referralCode: true,
            },
          });
          if (user) {
            row = {
              ...sub,
              user: {
                ...user,
                extraDeviceSlots: 0,
                trialGrantedAt: null,
                offerAcceptedAt: null,
                offerVersion: null,
                lastPromoActivatedAt: null,
                referredById: null,
              } as any,
            };
          }
        }
      }

      if (!row) {
        await replyExpired();
        return;
      }

      // Avoid hitting 3x-ui on every client refresh, but do sync when we likely need it.
      const nowMs = Date.now();
      const paidUntilMs = row.paidUntil?.getTime() ?? 0;
      const expiresMs = row.expiresAt?.getTime() ?? 0;
      const needsExtend = paidUntilMs > nowMs && (expiresMs === 0 || expiresMs < paidUntilMs);
      const lastSyncMs = row.lastSyncedAt?.getTime() ?? 0;
      const tooOld = lastSyncMs === 0 || nowMs - lastSyncMs > 2 * 60 * 1000;

      const state =
        needsExtend || tooOld
          ? await deps.subscriptions.syncFromXui(row.user).catch((err) => {
            req.log.error({ err }, "syncFromXui failed for /sub/:token");
            return { subscription: row, expiresAt: row.expiresAt ?? undefined, enabled: row.enabled };
          })
          : { subscription: row, expiresAt: row.expiresAt ?? undefined, enabled: row.enabled };

      const effectiveExpiresAt =
        state.expiresAt && state.subscription.paidUntil
          ? (state.expiresAt.getTime() > state.subscription.paidUntil.getTime() ? state.expiresAt : state.subscription.paidUntil)
          : (state.expiresAt ?? state.subscription.paidUntil ?? undefined);

      const isActive = !!effectiveExpiresAt && effectiveExpiresAt.getTime() > nowMs && state.enabled;

      // Check device limit and register/block device
      if (isActive) {
        const deviceInfo = detectAndLogDevice(req.headers as Record<string, string | undefined>, `/sub/${token}`, clientIp);

        /* 
           TODO: Re-enable device limits after confirming DB migration is applied.
           Currently disabled to prevent crashes on missing DeviceConfig table/columns.
        
        if (deviceInfo.fingerprint) {
          const registerResult = await deps.devices.registerDevice(row.user.id, deviceInfo, isActive).catch((err) => {
            req.log.error({ err }, "Failed to register device in /sub/:token");
            return { success: false, error: "Ошибка регистрации устройства" };
          });
          
          // If device limit reached, block connection
          if (!registerResult.success && "errorCode" in registerResult && registerResult.errorCode === "LIMIT_REACHED") {
            await replyExpired(`⚠️ ПРЕВЫШЕН ЛИМИТ УСТРОЙСТВ\n\nУдалите старое устройство или купите дополнительный слот в боте: ${deps.telegramBotUrl}`);
            return;
          }
        }
        */
      }

      const primaryServer = isActive
        ? await (async () => {
          try {
            const template = await deps.xui.getVlessRealityTemplate(state.subscription.xuiInboundId);
            return {
              name: "LisVPN",
              host: hostnameFromUrl(deps.backendPublicUrl),
              uuid: state.subscription.xuiClientUuid,
              flow: deps.xuiClientFlow,
              template,
            };
          } catch (err) {
            req.log.error({ err }, "getVlessRealityTemplate failed for /sub/:token");
            await replyExpired("Техническая ошибка на сервере (шаблон Reality недоступен). Попробуйте позже.");
            return null;
          }
        })()
        : null;

      if (isActive && primaryServer === null) return;

      const built = buildSubscription(
        { enabled: state.enabled, expiresAt: effectiveExpiresAt, telegramBotUrl: deps.telegramBotUrl },
        { primaryServer, fastServerUrls: deps.fastServerUrls, mobileBypassUrls: deps.mobileBypassUrls },
      );

      for (const [key, value] of Object.entries(built.headers)) reply.header(key, value);
      await reply.code(200).send(built.body);
    } catch (err) {
      req.log.error({ err }, "GET /sub/:token failed");
      await replyExpired("Техническая ошибка на сервере. Попробуйте позже.");
    }
  });
}
