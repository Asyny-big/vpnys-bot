import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { URL } from "node:url";
import type { ThreeXUiService } from "../integrations/threeXui/threeXuiService";
import type { SubscriptionService } from "../modules/subscription/subscriptionService";
import { buildSubscription } from "../modules/subscription/subscriptionBuilder";
import { qrSvg } from "./qr";

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
    backendPublicUrl: string;
    telegramBotUrl: string;
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

    const publicOrigin = publicOriginFromRequest(req);
    const baseSubUrl = `${publicOrigin.replace(/\/+$/, "")}/sub/${encodeURIComponent(token)}`;

    try {
      const row = await deps.prisma.subscription.findUnique({
        where: { xuiSubscriptionId: token },
        include: { user: true },
      });

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

      const userLabel = `user_${row.user.telegramId}`;
      const expiresLabel = effectiveExpiresAt ? formatDateRu(effectiveExpiresAt) : "—";
      const statusLabel = isActive ? "Активна" : "Истекла";
      const trafficLabel = "Безлимит";

      const qr = qrSvg(baseSubUrl, { pixels: 256 });

      const pageData = {
        token,
        subUrl: baseSubUrl,
        platform: "windows" as const,
      };

      const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#0b0f14" />
    <title>LisVPN — Подключение</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b0f14;
        --panel: rgba(16, 22, 31, 0.72);
        --panel2: rgba(16, 22, 31, 0.56);
        --border: rgba(255,255,255,0.10);
        --text: #e7edf4;
        --muted: rgba(231,237,244,0.72);
        --muted2: rgba(231,237,244,0.52);
        --accent: #00d1ff;
        --accent2: #ffaa00;
        --good: #43d37b;
        --bad: #ff5b6a;
        --shadow: 0 22px 70px rgba(0,0,0,0.42);
        --r-lg: 18px;
        --r-md: 14px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Apple Color Emoji","Segoe UI Emoji";
        background:
          radial-gradient(1200px 800px at 20% -10%, rgba(0, 209, 255, 0.18), transparent 55%),
          radial-gradient(900px 600px at 90% 0%, rgba(255, 170, 0, 0.12), transparent 45%),
          radial-gradient(900px 600px at 30% 120%, rgba(67, 211, 123, 0.10), transparent 55%),
          var(--bg);
        color: var(--text);
        overflow-x: hidden;
      }
      a { color: inherit; }
      .wrap { max-width: 980px; margin: 0 auto; padding: 22px 16px 54px; }
      .top {
        display:flex; align-items:center; justify-content:space-between;
        gap: 12px;
        margin-bottom: 16px;
      }
      .brand {
        display:flex; align-items:center; gap: 10px;
        font-weight: 800; letter-spacing: 0.2px;
      }
      .logo {
        width: 40px; height: 40px;
        border-radius: 14px;
        display:grid; place-items:center;
        background: linear-gradient(135deg, rgba(255, 170, 0, 0.18), rgba(0, 209, 255, 0.12));
        border: 1px solid var(--border);
        box-shadow: 0 12px 30px rgba(0,0,0,0.35);
      }
      .actions { display:flex; gap: 10px; align-items:center; }
      .iconBtn {
        display:inline-flex; align-items:center; gap: 10px;
        appearance:none; cursor:pointer;
        border-radius: 14px;
        padding: 10px 12px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        font-weight: 650;
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
      }
      .iconBtn:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18); }
      .iconBtn:active { transform: translateY(1px); }
      .icon {
        width: 18px; height: 18px; display:inline-block;
        opacity: 0.9;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }
      .subCard { padding: 18px; margin-bottom: 16px; }
      .subHead {
        display:flex; align-items:center; justify-content:space-between;
        gap: 12px;
        margin-bottom: 14px;
        min-width: 0;
      }
      .subTitle {
        display:flex; align-items:center; gap: 10px;
        font-size: 16px; font-weight: 800;
        min-width: 0;
      }
      .pill {
        display:inline-flex; align-items:center; gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        font-weight: 750;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.05);
        color: var(--muted);
        white-space: nowrap;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .pill.good { color: rgba(67, 211, 123, 0.98); border-color: rgba(67, 211, 123, 0.22); background: rgba(67, 211, 123, 0.07); }
      .pill.bad { color: rgba(255, 91, 106, 0.98); border-color: rgba(255, 91, 106, 0.22); background: rgba(255, 91, 106, 0.06); }
      .grid {
        display:grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .item {
        border: 1px solid rgba(255,255,255,0.10);
        background: rgba(0,0,0,0.18);
        border-radius: var(--r-md);
        padding: 12px;
        display:flex; gap: 10px; align-items:flex-start;
        min-width: 0;
        overflow: hidden;
      }
      .item .ic {
        width: 34px; height: 34px; border-radius: 12px;
        display:grid; place-items:center;
        border: 1px solid rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.05);
        flex: 0 0 auto;
      }
      .item .txt { min-width: 0; }
      .item .k { color: var(--muted2); font-size: 12px; letter-spacing: 0.2px; }
      .item .v { margin-top: 2px; font-size: 14px; font-weight: 750; }
      .item .v { overflow-wrap: anywhere; word-break: break-all; }
      .sectionTitle {
        margin: 16px 4px 10px;
        color: rgba(231,237,244,0.88);
        font-size: 14px;
        font-weight: 850;
        letter-spacing: 0.3px;
      }
      .platforms {
        display:flex; gap: 8px; flex-wrap: wrap;
        padding: 12px;
        background: var(--panel2);
        border: 1px solid var(--border);
        border-radius: var(--r-lg);
      }
      .appSelect {
        margin-top: 10px;
        padding: 12px;
        background: var(--panel2);
        border: 1px solid var(--border);
        border-radius: var(--r-lg);
        display:flex;
        gap: 10px;
        align-items:center;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      .appSelect .label {
        color: rgba(231,237,244,0.88);
        font-size: 13px;
        font-weight: 850;
        letter-spacing: 0.2px;
      }
      .selectWrap { flex: 1 1 320px; min-width: 240px; }
      .select {
        width: 100%;
        appearance: none;
        cursor: pointer;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(0,0,0,0.22);
        color: var(--text);
        font-weight: 850;
        padding: 12px 14px;
        line-height: 1.2;
      }
      .select:disabled { opacity: 0.6; cursor: not-allowed; }
      .appHint { margin-top: 8px; color: var(--muted2); font-size: 12.5px; line-height: 1.45; }
      .tab {
        appearance:none; cursor:pointer;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        font-weight: 750;
        padding: 10px 12px;
        min-width: 104px;
        text-align: center;
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
      }
      .tab:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.16); }
      .tab:active { transform: translateY(1px); }
      .tab[aria-selected="true"] {
        border-color: rgba(0, 209, 255, 0.36);
        background: linear-gradient(180deg, rgba(0, 209, 255, 0.14), rgba(0, 0, 0, 0.10));
        box-shadow: 0 14px 40px rgba(0, 209, 255, 0.12);
      }
      .stepsCard { margin-top: 12px; padding: 16px; }
      .steps { margin: 0; padding: 0; list-style: none; display:flex; flex-direction: column; gap: 10px; }
      .step {
        display:flex; gap: 12px; align-items:flex-start;
        padding: 12px;
        border-radius: var(--r-md);
        border: 1px solid rgba(255,255,255,0.10);
        background: rgba(0,0,0,0.16);
      }
      .num {
        width: 28px; height: 28px;
        border-radius: 10px;
        display:grid; place-items:center;
        background: rgba(0, 209, 255, 0.12);
        border: 1px solid rgba(0, 209, 255, 0.22);
        color: rgba(0, 209, 255, 0.98);
        font-weight: 900;
        flex: 0 0 auto;
      }
      .step .t { font-weight: 820; }
      .step .d { margin-top: 2px; color: var(--muted); font-size: 13px; line-height: 1.45; }
      .primaryWrap { margin-top: 14px; }
      .primary {
        width: 100%;
        display: block;
        appearance:none; cursor:pointer;
        padding: 14px 14px;
        border-radius: 16px;
        border: 1px solid rgba(0, 209, 255, 0.32);
        background: linear-gradient(135deg, rgba(0, 209, 255, 0.22), rgba(255, 170, 0, 0.14));
        color: #f4fbff;
        font-weight: 900;
        font-size: 16px;
        box-shadow: 0 20px 60px rgba(0, 209, 255, 0.10), 0 20px 60px rgba(255, 170, 0, 0.06);
        transition: transform 120ms ease, filter 120ms ease;
        text-decoration: none;
        text-align: center;
      }
      .primary:active { transform: translateY(1px); }
      .primary[aria-disabled="true"] {
        opacity: 0.48;
        cursor: not-allowed;
        filter: saturate(0.85);
        box-shadow: none;
        border-color: rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        pointer-events: none;
      }
      .primary[aria-disabled="true"]:active { transform: none; }
      .small {
        margin-top: 12px;
        color: var(--muted2);
        font-size: 12.5px;
        line-height: 1.55;
      }
      .row { display:flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
      .secondary {
        appearance:none; cursor:pointer;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        font-weight: 800;
        padding: 10px 12px;
      }
      .secondary:active { transform: translateY(1px); }
      .manual {
        margin-top: 10px;
        display:none;
        gap: 10px;
        align-items:center;
      }
      .manual[aria-hidden="false"] { display:flex; }
      .input {
        flex: 1 1 auto;
        padding: 11px 12px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(0,0,0,0.22);
        color: var(--text);
        font-weight: 650;
        min-width: 0;
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        background: rgba(16, 22, 31, 0.92);
        border: 1px solid rgba(255,255,255,0.14);
        color: var(--text);
        border-radius: 14px;
        padding: 10px 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.45);
        max-width: min(520px, calc(100vw - 24px));
        display:none;
      }
      .toast[aria-hidden="false"] { display:block; }
      .toast .m { color: var(--muted); font-size: 13px; margin-top: 2px; }
      .overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.56);
        display:none;
        align-items: center;
        justify-content: center;
        padding: 18px;
      }
      .overlay[aria-hidden="false"] { display:flex; }
      .modal {
        width: min(420px, 100%);
        background: rgba(16, 22, 31, 0.92);
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 18px;
        box-shadow: 0 26px 90px rgba(0,0,0,0.55);
        padding: 16px;
      }
      .modalHead { display:flex; align-items:center; justify-content:space-between; gap: 10px; margin-bottom: 10px; }
      .modalTitle { font-weight: 900; }
      .close {
        appearance:none; cursor:pointer;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        padding: 8px 10px;
        font-weight: 900;
      }
      .qrBox {
        display:grid;
        place-items: center;
        background: #ffffff;
        border-radius: 16px;
        padding: 14px;
      }
      .qrHint { margin-top: 10px; color: var(--muted); font-size: 13px; line-height: 1.5; text-align:center; }
      @media (max-width: 640px) {
        .wrap { padding-top: 16px; }
        .iconBtn span { display:none; }
        .iconBtn { padding: 10px; }
        .grid { grid-template-columns: 1fr; }
        .tab { min-width: 0; flex: 1 1 auto; }
        .subHead { flex-wrap: wrap; }
        .pill { max-width: 100%; }
      }
      @media (max-width: 480px) {
        .selectWrap { flex-basis: 100%; min-width: 0; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="brand">
          <div class="logo">🦊</div>
          <div>LisVPN</div>
        </div>
        <div class="actions">
          <button class="iconBtn" id="copySubBtn" type="button" title="Скопировать ссылку подписки">
            <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 9h10v10H9V9Z" stroke="currentColor" stroke-width="1.8"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.8"/></svg>
            <span>Скопировать ссылку</span>
          </button>
          <button class="iconBtn" id="qrBtn" type="button" title="Показать QR-код">
            <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 4h7v7H4V4Zm2 2v3h3V6H6Zm7-2h7v7h-7V4Zm2 2v3h3V6h-3ZM4 13h7v7H4v-7Zm2 2v3h3v-3H6Zm10 0h-3v-2h5v5h-2v-3Zm0 7v-2h2v2h-2Zm-3 0h-2v-5h2v5Zm7 0h-5v-2h3v-3h2v5Z" fill="currentColor"/></svg>
            <span>QR-код</span>
          </button>
        </div>
      </div>

      <div class="card subCard">
        <div class="subHead">
          <div class="subTitle">
            <span>Подписка</span>
            <span class="pill ${isActive ? "good" : "bad"}">${escapeHtml(statusLabel)}</span>
          </div>
          <span class="pill">${escapeHtml(userLabel)}</span>
        </div>
        <div class="grid">
          <div class="item">
            <div class="ic">👤</div>
            <div class="txt">
              <div class="k">Имя пользователя</div>
              <div class="v">${escapeHtml(userLabel)}</div>
            </div>
          </div>
          <div class="item">
            <div class="ic">${isActive ? "✅" : "⏳"}</div>
            <div class="txt">
              <div class="k">Статус</div>
              <div class="v">${escapeHtml(statusLabel)}</div>
            </div>
          </div>
          <div class="item">
            <div class="ic">📅</div>
            <div class="txt">
              <div class="k">Истекает</div>
              <div class="v">${escapeHtml(expiresLabel)}</div>
            </div>
          </div>
          <div class="item">
            <div class="ic">📶</div>
            <div class="txt">
              <div class="k">Трафик</div>
              <div class="v">${escapeHtml(trafficLabel)}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="sectionTitle">Выберите платформу</div>
      <div class="platforms" role="tablist" aria-label="Платформа">
        <button class="tab" role="tab" data-platform="windows" aria-selected="true" type="button">Windows</button>
        <button class="tab" role="tab" data-platform="android" aria-selected="false" type="button">Android</button>
        <button class="tab" role="tab" data-platform="ios" aria-selected="false" type="button">iOS</button>
        <button class="tab" role="tab" data-platform="macos" aria-selected="false" type="button">macOS</button>
      </div>

      <div class="appSelect" aria-label="Выбор приложения">
        <div class="label">Выберите приложение</div>
        <div class="selectWrap">
          <select class="select" id="appSelect" aria-label="Выберите приложение">
            <option value="" selected disabled>Выберите приложение</option>
          </select>
          <div class="appHint" id="appHint">Выберите платформу, затем приложение — и добавьте подписку в один клик.</div>
        </div>
      </div>

      <div class="card stepsCard" aria-live="polite">
        <div class="sectionTitle" style="margin-top:0">Инструкция</div>
        <ul class="steps" id="steps"></ul>

        <div class="primaryWrap">
          <a class="primary" id="primaryBtn" href="#" role="button" aria-disabled="true">📲 Добавить подписку</a>
        </div>

        <div class="small">Если приложение не открылось — установите его и повторите, либо добавьте подписку вручную.</div>
        <div class="row">
          <button class="secondary" id="showLinkBtn" type="button">Показать ссылку</button>
        </div>
        <div class="manual" id="manual" aria-hidden="true">
          <input class="input" id="manualInput" readonly value="${escapeHtml(baseSubUrl)}" />
          <button class="secondary" id="manualCopyBtn" type="button">Скопировать</button>
        </div>
      </div>
    </div>

    <div class="toast" id="toast" aria-hidden="true">
      <div id="toastTitle" style="font-weight:850">Подсказка</div>
      <div class="m" id="toastMsg"></div>
    </div>

    <div class="overlay" id="qrOverlay" aria-hidden="true" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="modalHead">
          <div class="modalTitle">QR-код подписки</div>
          <button class="close" id="qrClose" type="button" aria-label="Закрыть">✕</button>
        </div>
        <div class="qrBox">${qr}</div>
        <div class="qrHint">Откройте камеру на телефоне и отсканируйте QR-код, чтобы добавить подписку.</div>
      </div>
    </div>

    <script>
      (function () {
        const data = ${safeJson(pageData)};
        const subUrl = data.subUrl;

        data.appId = '';

        const appCatalog = {
          windows: [
            { id: 'clashverge', label: 'Clash Verge', deeplink: (url) => 'clash://install-config?url=' + encodeURIComponent(url) },
            { id: 'hiddify', label: 'Hiddify', deeplink: (url) => 'hiddify://import/' + encodeURIComponent(url) },
          ],
          android: [
            { id: 'v2rayng', label: 'V2RayNG', deeplink: (url) => 'v2rayng://install-config?url=' + encodeURIComponent(url) },
            { id: 'singbox', label: 'Sing-box', deeplink: (url) => 'sing-box://import?url=' + encodeURIComponent(url) },
            { id: 'hiddify', label: 'Hiddify', deeplink: (url) => 'hiddify://import/' + encodeURIComponent(url) },
            { id: 'v2raytun', label: 'v2rayTun', deeplink: (url) => 'v2raytun://import?url=' + encodeURIComponent(url) },
            // Happ (как на скриншоте): "happ://add/<subscriptionUrl>" без query-параметра.
            { id: 'happ', label: 'Happ', deeplink: (url) => 'happ://add/' + url },
          ],
          ios: [
            { id: 'shadowrocket', label: 'Shadowrocket', deeplink: (url) => 'shadowrocket://add/sub?url=' + encodeURIComponent(url) },
            { id: 'singbox', label: 'Sing-box', deeplink: (url) => 'sing-box://import?url=' + encodeURIComponent(url) },
          ],
          macos: [
            { id: 'clashverge', label: 'Clash Verge', deeplink: (url) => 'clash://install-config?url=' + encodeURIComponent(url) },
            { id: 'hiddify', label: 'Hiddify', deeplink: (url) => 'hiddify://import/' + encodeURIComponent(url) },
          ],
        };

        const tabs = Array.from(document.querySelectorAll('.tab'));
        const stepsEl = document.getElementById('steps');
        const appSelect = document.getElementById('appSelect');
        const appHint = document.getElementById('appHint');
        const primaryBtn = document.getElementById('primaryBtn');
        const toast = document.getElementById('toast');
        const toastTitle = document.getElementById('toastTitle');
        const toastMsg = document.getElementById('toastMsg');
        const manual = document.getElementById('manual');
        const manualInput = document.getElementById('manualInput');

        function showToast(title, msg) {
          toastTitle.textContent = title;
          toastMsg.textContent = msg;
          toast.setAttribute('aria-hidden', 'false');
          clearTimeout(showToast._t);
          showToast._t = setTimeout(() => toast.setAttribute('aria-hidden', 'true'), 2600);
        }

        async function copyText(text, okLabel) {
          try {
            await navigator.clipboard.writeText(text);
            showToast('Скопировано', okLabel || 'Ссылка в буфере обмена');
            return true;
          } catch (e) {
            try { prompt('Скопируйте ссылку:', text); } catch {}
            return false;
          }
        }

        function appsForPlatform(platform) {
          return appCatalog[platform] || [];
        }

        function selectedApp() {
          const apps = appsForPlatform(data.platform);
          return apps.find((a) => a.id === data.appId) || null;
        }

        function renderAppSelect(platform) {
          const apps = appsForPlatform(platform);
          const hasSelected = apps.some((a) => a.id === data.appId);
          if (!hasSelected) data.appId = '';

          appSelect.innerHTML = ['<option value=\"\" ' + (data.appId ? '' : 'selected') + ' disabled>Выберите приложение</option>']
            .concat(apps.map((a) => '<option value=\"' + a.id + '\" ' + (a.id === data.appId ? 'selected' : '') + '>' + a.label + '</option>'))
            .join('');

          appSelect.disabled = apps.length === 0;
          if (apps.length === 0) {
            appHint.textContent = 'Для этой платформы пока нет поддерживаемых приложений.';
          } else {
            appHint.textContent = 'После выбора приложения кнопка станет активной.';
          }
        }

        function updatePrimary() {
          const app = selectedApp();
          const enabled = !!app;
          primaryBtn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
          primaryBtn.textContent = app ? ('📲 Добавить в ' + app.label) : '📲 Добавить подписку';
          primaryBtn.href = enabled ? app.deeplink(subUrl) : '#';
        }

        function renderSteps(platform) {
          const app = selectedApp();
          const appName = app ? app.label : 'приложение';
          const steps = [
            { t: 'Скачать приложение', d: app ? appName : 'Выберите приложение ниже' },
            { t: 'Импортировать подписку', d: 'Нажмите «Добавить подписку» ниже' },
            { t: 'Подключиться', d: platform === 'android' ? 'Включите VPN в приложении' : 'Выберите сервер и включите VPN' },
          ];
          stepsEl.innerHTML = steps.map((s, i) => (
            '<li class=\"step\">' +
              '<div class=\"num\">' + (i + 1) + '</div>' +
              '<div><div class=\"t\">' + s.t + '</div><div class=\"d\">' + s.d + '</div></div>' +
            '</li>'
          )).join('');
        }

        function setPlatform(next) {
          data.platform = next;
          tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.platform === next)));
          renderAppSelect(next);
          renderSteps(next);
          updatePrimary();
        }

        tabs.forEach((t) => t.addEventListener('click', () => setPlatform(t.dataset.platform)));

        appSelect.addEventListener('change', () => {
          data.appId = String(appSelect.value || '');
          renderSteps(data.platform);
          updatePrimary();
        });

        setPlatform('windows');

        document.getElementById('copySubBtn')?.addEventListener('click', () => copyText(subUrl, 'Ссылка подписки скопирована'));

        const qrOverlay = document.getElementById('qrOverlay');
        const qrClose = document.getElementById('qrClose');
        function closeQr() { qrOverlay.setAttribute('aria-hidden', 'true'); }
        document.getElementById('qrBtn')?.addEventListener('click', () => qrOverlay.setAttribute('aria-hidden', 'false'));
        qrClose?.addEventListener('click', closeQr);
        qrOverlay?.addEventListener('click', (e) => { if (e.target === qrOverlay) closeQr(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeQr(); });

        document.getElementById('showLinkBtn')?.addEventListener('click', () => {
          const isHidden = manual.getAttribute('aria-hidden') !== 'false';
          manual.setAttribute('aria-hidden', isHidden ? 'false' : 'true');
          if (isHidden) manualInput?.select?.();
        });
        document.getElementById('manualCopyBtn')?.addEventListener('click', () => copyText(subUrl, 'Ссылка подписки скопирована'));

        primaryBtn?.addEventListener('click', (e) => {
          if (primaryBtn.getAttribute('aria-disabled') === 'true') {
            e.preventDefault();
            showToast('Выберите приложение', 'Сначала выберите приложение для импорта подписки.');
          }
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

    try {
      const row = await deps.prisma.subscription.findUnique({
        where: { xuiSubscriptionId: token },
        include: { user: true },
      });

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
        { primaryServer, mobileBypassUrls: deps.mobileBypassUrls },
      );

      for (const [key, value] of Object.entries(built.headers)) reply.header(key, value);
      await reply.code(200).send(built.body);
    } catch (err) {
      req.log.error({ err }, "GET /sub/:token failed");
      await replyExpired("Техническая ошибка на сервере. Попробуйте позже.");
    }
  });
}
