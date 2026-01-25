import type { VlessRealityTemplate } from "../../integrations/threeXui/threeXuiService";

export const SUBSCRIPTION_TITLE = "🦊 ЛисVPN";
export const SUBSCRIPTION_BRAND = "LisVPN";

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

function buildHeaders(params: { title: string; expireUnix: number }): Record<string, string> {
  const title = params.title;
  const expireUnix = params.expireUnix;

  const asciiFallbackFilename = "LisVPN";
  const cd = [
    "attachment",
    `filename="${asciiFallbackFilename}"`,
    `filename*=UTF-8''${rfc5987Encode(title)}`,
  ].join("; ");

  return {
    "Content-Type": "text/plain; charset=utf-8",
    // Shadowrocket/Hiddify/sing-box: robust UTF-8 via base64.
    "Profile-Title": `base64:${base64Utf8(title)}`,
    // Some clients use filename/filename* as profile name.
    "Content-Disposition": cd,
    // Many clients use this header to show "traffic bar" and expiration.
    "Subscription-Userinfo": `upload=0; download=0; total=0; expire=${expireUnix}`,
    "Cache-Control": "no-store",
  };
}

function buildMeta(expiresAt?: Date | null): string[] {
  return [
    `# ${SUBSCRIPTION_BRAND}`,
    `# upload=0; download=0; total=0; expire=${unixSeconds(expiresAt)}`,
  ];
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

export function buildSubscription(user: BuildSubscriptionUser, servers: ReadonlyArray<SubscriptionServer>): BuiltSubscription {
  const nowMs = Date.now();
  const expiresMs = user.expiresAt ? user.expiresAt.getTime() : 0;
  const isExpired = !user.enabled || !user.expiresAt || expiresMs <= nowMs;

  const expireUnix = unixSeconds(user.expiresAt);
  const headers = buildHeaders({ title: SUBSCRIPTION_TITLE, expireUnix });

  if (isExpired) {
    return {
      headers,
      body: `${buildExpiredText(user.telegramBotUrl)}\n`,
    };
  }

  const lines: string[] = [];
  lines.push(...buildMeta(user.expiresAt));
  for (const server of servers) lines.push(buildVlessUrl(server));
  return { headers, body: `${lines.join("\n")}\n` };
}
