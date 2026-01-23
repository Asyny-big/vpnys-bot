import { URL } from "node:url";

type Env = Readonly<{
  nodeEnv: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";

  appHost: string;
  appPort: number;

  databaseUrl: string;
  telegramBotToken: string;
  adminUsername?: string;

  // What users receive in /sub/<subscription_id> URL (can be public host / reverse proxy).
  publicPanelBaseUrl: string;

  // Must be localhost-only for security.
  xuiBaseUrl: string;
  xuiUsername: string;
  xuiPassword: string;
  xuiInboundId: number;
  xuiClientFlow?: string;

  webhookToken: string;

  yookassaShopId?: string;
  yookassaSecretKey?: string;
  cryptobotApiToken?: string;
  paymentsReturnUrl?: string;

  plan30RubMinor: number;
  plan90RubMinor: number;
  plan180RubMinor: number;

  cryptobotAsset: string;
  cryptobotPlan30Amount?: string;
  cryptobotPlan90Amount?: string;
  cryptobotPlan180Amount?: string;
  cryptobotDeviceSlotAmount?: string;

  workerIntervalSeconds: number;
}>;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value?.length ? value : undefined;
}

function asInt(name: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid int env ${name}: ${value}`);
  return parsed;
}

function ensureUrl(name: string, value: string): string {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    throw new Error(`Invalid url env ${name}: ${value}`);
  }
  return value;
}

function ensureXuiLocalhost(baseUrl: string): void {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  const isLocal =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1";
  if (!isLocal) {
    throw new Error(
      `Security: XUI_BASE_URL must be localhost-only, got ${url.hostname}. Use a reverse proxy for public access.`,
    );
  }
}

export function loadEnv(): Env {
  const nodeEnvRaw = process.env.NODE_ENV ?? "development";
  if (nodeEnvRaw !== "development" && nodeEnvRaw !== "test" && nodeEnvRaw !== "production") {
    throw new Error(`Invalid NODE_ENV: ${nodeEnvRaw}`);
  }

  const logLevel = (process.env.LOG_LEVEL ?? "info") as Env["logLevel"];

  const xuiBaseUrl = ensureUrl("XUI_BASE_URL", required("XUI_BASE_URL"));
  ensureXuiLocalhost(xuiBaseUrl);

  const databaseUrl = required("DATABASE_URL");
  if (databaseUrl !== "file:./data.db") {
    throw new Error(`Only SQLite is supported. Set DATABASE_URL=file:./data.db (got: ${databaseUrl})`);
  }

  return {
    nodeEnv: nodeEnvRaw,
    logLevel,

    appHost: process.env.APP_HOST ?? "0.0.0.0",
    appPort: asInt("APP_PORT", process.env.APP_PORT ?? "3000"),

    databaseUrl,
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    adminUsername: optional("ADMIN_USERNAME"),

    publicPanelBaseUrl: ensureUrl("PUBLIC_PANEL_BASE_URL", required("PUBLIC_PANEL_BASE_URL")),

    xuiBaseUrl,
    xuiUsername: required("XUI_USERNAME"),
    xuiPassword: required("XUI_PASSWORD"),
    xuiInboundId: asInt("XUI_INBOUND_ID", required("XUI_INBOUND_ID")),
    xuiClientFlow: optional("XUI_CLIENT_FLOW"),

    webhookToken: required("WEBHOOK_TOKEN"),

    yookassaShopId: optional("YOOKASSA_SHOP_ID"),
    yookassaSecretKey: optional("YOOKASSA_SECRET_KEY"),
    cryptobotApiToken: optional("CRYPTOBOT_API_TOKEN"),

    paymentsReturnUrl: optional("PAYMENTS_RETURN_URL"),

    plan30RubMinor: asInt("PLAN_30_RUB_MINOR", process.env.PLAN_30_RUB_MINOR ?? "0"),
    plan90RubMinor: asInt("PLAN_90_RUB_MINOR", process.env.PLAN_90_RUB_MINOR ?? "0"),
    plan180RubMinor: asInt("PLAN_180_RUB_MINOR", process.env.PLAN_180_RUB_MINOR ?? "0"),

    cryptobotAsset: process.env.CRYPTOBOT_ASSET ?? "USDT",
    cryptobotPlan30Amount: optional("CRYPTOBOT_PLAN_30_AMOUNT"),
    cryptobotPlan90Amount: optional("CRYPTOBOT_PLAN_90_AMOUNT"),
    cryptobotPlan180Amount: optional("CRYPTOBOT_PLAN_180_AMOUNT"),
    cryptobotDeviceSlotAmount: optional("CRYPTOBOT_DEVICE_SLOT_AMOUNT"),

    workerIntervalSeconds: asInt("WORKER_INTERVAL_SECONDS", process.env.WORKER_INTERVAL_SECONDS ?? "300")
  };
}
