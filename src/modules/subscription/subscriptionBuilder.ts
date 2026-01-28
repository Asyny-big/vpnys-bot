import type { VlessRealityTemplate } from "../../integrations/threeXui/threeXuiService";

export const SUBSCRIPTION_TITLE = "🦊 ЛисVPN";
export const SUBSCRIPTION_BRAND = "LisVPN";

const PRIMARY_BLOCK: ReadonlyArray<string> = [
  "# =========================================",
  "# 🔥 LisVPN — основной сервер (рекомендуется)",
  "# 🇪🇪 Эстония • высокая скорость • стабильный",
  "# YouTube • Instagram • Игры",
  "# =========================================",
];

const MOBILE_BYPASS_BLOCK: ReadonlyArray<string> = [
  "# =========================================",
  "# 🌍 Обход блокировок (мобильный интернет)",
  "# LTE / 4G / 5G • Best-effort",
  "# Используйте, если основной сервер недоступен",
  "# =========================================",
];

const PRIMARY_SERVER_DISPLAY_NAME = "🔥 LisVPN 🇪🇪 Эстония — Быстро и стабильно";

export type BuildSubscriptionUser = Readonly<{
  expiresAt?: Date | null;
  enabled: boolean;
  telegramBotUrl: string;
}>;

export type SubscriptionServer = Readonly<{
  name: string; // How it should be displayed in clients
  host: string;
  uuid: string;
  flow?: string;
  template: VlessRealityTemplate;
}>;

export type BuiltSubscription = Readonly<{
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type BuildSubscriptionParams = Readonly<{
  primaryServer?: SubscriptionServer | null;
  mobileBypassUrls?: ReadonlyArray<string>;
}>;

function unixSeconds(date?: Date | null): number {
  if (!date) return 0;
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

function base64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function rfc5987Encode(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

function buildHeaders(params: { title: string; expireUnix: number; telegramBotUrl: string; isExpired?: boolean }): Record<string, string> {
  const title = params.title;
  const expireUnix = params.expireUnix;

  const asciiFallbackFilename = "LisVPN";
  const cd = [
    "attachment",
    `filename="${asciiFallbackFilename}"`,
    `filename*=UTF-8''${rfc5987Encode(title)}`,
  ].join("; ");

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    // Shadowrocket/Hiddify/sing-box: robust UTF-8 via base64.
    "Profile-Title": `base64:${base64Utf8(title)}`,
    // Some clients use filename/filename* as profile name.
    "Content-Disposition": cd,
    // Many clients use this header to show "traffic bar" and expiration.
    "Subscription-Userinfo": `upload=0; download=0; total=0; expire=${expireUnix}`,
    // Force clients to refresh subscription config every hour (value in hours).
    // This ensures expired subscriptions are detected quickly and bypass servers are removed.
    "Profile-Update-Interval": "1",
    // Telegram bot button in Happ/Hiddify (paper plane icon)
    "Support-URL": params.telegramBotUrl,
    "Profile-Web-Page-URL": params.telegramBotUrl,
    "Cache-Control": "no-store",
  };

  // Add notice for expired subscriptions (Hiddify/Happ display this)
  if (params.isExpired) {
    headers["Profile-Update-Interval"] = "1"; // Check every hour for renewal
    // Some clients support this header for displaying messages
    headers["Subscription-Notice"] = base64Utf8("⚠️ Подписка истекла. Оплатите в Telegram →");
  } else {
    // Helpful tip for active subscriptions
    headers["Subscription-Notice"] = base64Utf8("🦊 Если не работает — протестируйте все серверы и обновите подписку ↻");
  }

  return headers;
}

function buildExpiredText(botUrl: string): string {
  return [
    `❌ Подписка ${SUBSCRIPTION_BRAND} истекла.`,
    "🔁 Для продления перейдите в Telegram:",
    botUrl,
  ].join("\n");
}

function buildVlessUrl(server: SubscriptionServer): string {
  const params = new URLSearchParams();
  params.set("encryption", "none");

  if (server.flow) params.set("flow", server.flow);

  // Reality
  params.set("security", "reality");
  params.set("sni", server.template.sni);
  if (server.template.fingerprint) params.set("fp", server.template.fingerprint);
  if (server.template.alpn) params.set("alpn", server.template.alpn);
  params.set("pbk", server.template.publicKey);
  if (server.template.shortId) params.set("sid", server.template.shortId);
  if (server.template.spiderX) params.set("spx", server.template.spiderX);

  // Transport
  params.set("type", server.template.network);
  if (server.template.network === "tcp" && server.template.tcpHeaderType) {
    params.set("headerType", server.template.tcpHeaderType);
  }
  if (server.template.network === "ws") {
    if (server.template.wsPath) params.set("path", server.template.wsPath);
    if (server.template.wsHost) params.set("host", server.template.wsHost);
  }
  if (server.template.network === "grpc" && server.template.grpcServiceName) {
    params.set("serviceName", server.template.grpcServiceName);
  }

  const name = encodeURIComponent(server.name);
  return `vless://${server.uuid}@${server.host}:${server.template.port}?${params.toString()}#${name}`;
}

function withUrlName(rawUrl: string, name: string): string {
  const trimmed = rawUrl.trim();
  const i = trimmed.indexOf("#");
  const base = i === -1 ? trimmed : trimmed.slice(0, i);
  return `${base}#${encodeURIComponent(name)}`;
}

export function buildSubscription(user: BuildSubscriptionUser, params: BuildSubscriptionParams): BuiltSubscription {
  const nowMs = Date.now();
  const expiresMs = user.expiresAt ? user.expiresAt.getTime() : 0;
  const isExpired = !user.enabled || !user.expiresAt || expiresMs <= nowMs;

  const expireUnix = unixSeconds(user.expiresAt);
  const headers = buildHeaders({
    title: SUBSCRIPTION_TITLE,
    expireUnix,
    telegramBotUrl: user.telegramBotUrl,
    isExpired,
  });

  if (isExpired) {
    // Return empty body - clients will clear all servers without parse errors
    // UX messages are sent via Telegram and shown via Support-URL button
    return {
      headers,
      body: "",
    };
  }

  if (!params.primaryServer) {
    return {
      headers,
      body: "Техническая ошибка на сервере (не задан основной сервер).\n",
    };
  }

  const lines: string[] = [];
  lines.push(...PRIMARY_BLOCK);
  lines.push(buildVlessUrl({ ...params.primaryServer, name: PRIMARY_SERVER_DISPLAY_NAME }));
  lines.push(...MOBILE_BYPASS_BLOCK);

  const mobileUrls = (params.mobileBypassUrls ?? []).map((u) => u.trim()).filter(Boolean);
  for (let i = 0; i < mobileUrls.length; i++) {
    lines.push(withUrlName(mobileUrls[i]!, `🌍 Обход №${i + 1}`));
  }

  return { headers, body: `${lines.join("\n")}\n` };
}
