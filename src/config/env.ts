import { URL } from "node:url";
import { EXTRA_DEVICE_RUB } from "../domain/pricing";

type Env = Readonly<{
  nodeEnv: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";

  appHost: string;
  appPort: number;

  databaseUrl: string;
  telegramBotToken: string;
  adminUsername?: string;
  adminUserIds: ReadonlySet<string>;

  // What users receive in /sub/<subscription_id> URL (can be public host / reverse proxy).
  publicPanelBaseUrl: string;

  offerVersion: string;

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

  plan30Rub: number;
  plan90Rub: number;
  plan180Rub: number;

  cryptobotAsset: string;
  rubToUsdtRate?: number; // RUB per 1 USDT (e.g. 100 means 100 ₽ ≈ 1 USDT)
  cryptobotPlan30Rub?: number;
  cryptobotPlan90Rub?: number;
  cryptobotPlan180Rub?: number;
  cryptobotDeviceSlotRub?: number;

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

function parseIdSet(value: string | undefined): ReadonlySet<string> {
  if (!value?.trim().length) return new Set<string>();
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return new Set(ids);
}

function asInt(name: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid int env ${name}: ${value}`);
  return parsed;
}

function asNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number env ${name}: ${value}`);
  return parsed;
}

function requirePositiveInt(name: string): number {
  const value = asInt(name, required(name));
  if (value <= 0) throw new Error(`${name} must be > 0 (got: ${value})`);
  return value;
}

function optionalPositiveInt(name: string): number | undefined {
  const raw = optional(name);
  if (raw === undefined) return undefined;
  const value = asInt(name, raw);
  if (value <= 0) throw new Error(`${name} must be > 0 (got: ${value})`);
  return value;
}

function requirePositiveNumber(name: string): number {
  const value = asNumber(name, required(name));
  if (value <= 0) throw new Error(`${name} must be > 0 (got: ${value})`);
  return value;
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

  const offerVersion = required("OFFER_VERSION").trim();
  if (!offerVersion.length) throw new Error("OFFER_VERSION must be non-empty");

  const yookassaShopId = optional("YOOKASSA_SHOP_ID");
  const yookassaSecretKey = optional("YOOKASSA_SECRET_KEY");
  const cryptobotApiToken = optional("CRYPTOBOT_API_TOKEN");
  const paymentsReturnUrlRaw = optional("PAYMENTS_RETURN_URL");
  const paymentsReturnUrl = paymentsReturnUrlRaw ? ensureUrl("PAYMENTS_RETURN_URL", paymentsReturnUrlRaw) : undefined;

  const plan30Rub = requirePositiveInt("PLAN_30_RUB");
  const plan90Rub = requirePositiveInt("PLAN_90_RUB");
  const plan180Rub = requirePositiveInt("PLAN_180_RUB");

  const rubToUsdtRate = cryptobotApiToken ? requirePositiveNumber("RUB_TO_USDT_RATE") : undefined;
  const cryptobotPlan30Rub = optionalPositiveInt("CRYPTOBOT_PLAN_30_RUB");
  const cryptobotPlan90Rub = optionalPositiveInt("CRYPTOBOT_PLAN_90_RUB");
  const cryptobotPlan180Rub = optionalPositiveInt("CRYPTOBOT_PLAN_180_RUB");
  const cryptobotDeviceSlotRub = optionalPositiveInt("CRYPTOBOT_DEVICE_SLOT_RUB");

  if (cryptobotApiToken) {
    if (cryptobotPlan30Rub !== undefined && cryptobotPlan30Rub !== plan30Rub) {
      throw new Error(`CRYPTOBOT_PLAN_30_RUB must equal PLAN_30_RUB (got: ${cryptobotPlan30Rub}, expected: ${plan30Rub})`);
    }
    if (cryptobotPlan90Rub !== undefined && cryptobotPlan90Rub !== plan90Rub) {
      throw new Error(`CRYPTOBOT_PLAN_90_RUB must equal PLAN_90_RUB (got: ${cryptobotPlan90Rub}, expected: ${plan90Rub})`);
    }
    if (cryptobotPlan180Rub !== undefined && cryptobotPlan180Rub !== plan180Rub) {
      throw new Error(`CRYPTOBOT_PLAN_180_RUB must equal PLAN_180_RUB (got: ${cryptobotPlan180Rub}, expected: ${plan180Rub})`);
    }
    if (cryptobotDeviceSlotRub !== undefined && cryptobotDeviceSlotRub !== EXTRA_DEVICE_RUB) {
      throw new Error(`CRYPTOBOT_DEVICE_SLOT_RUB must be ${EXTRA_DEVICE_RUB} (got: ${cryptobotDeviceSlotRub})`);
    }
  }

  return {
    nodeEnv: nodeEnvRaw,
    logLevel,

    appHost: process.env.APP_HOST ?? "0.0.0.0",
    appPort: asInt("APP_PORT", process.env.APP_PORT ?? "3000"),

    databaseUrl,
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    adminUsername: optional("ADMIN_USERNAME"),
    adminUserIds: parseIdSet(optional("ADMIN_USER_IDS")),

    publicPanelBaseUrl: ensureUrl("PUBLIC_PANEL_BASE_URL", required("PUBLIC_PANEL_BASE_URL")),

    offerVersion,

    xuiBaseUrl,
    xuiUsername: required("XUI_USERNAME"),
    xuiPassword: required("XUI_PASSWORD"),
    xuiInboundId: asInt("XUI_INBOUND_ID", required("XUI_INBOUND_ID")),
    xuiClientFlow: optional("XUI_CLIENT_FLOW"),

    webhookToken: required("WEBHOOK_TOKEN"),

    yookassaShopId,
    yookassaSecretKey,
    cryptobotApiToken,

    paymentsReturnUrl,

    plan30Rub,
    plan90Rub,
    plan180Rub,

    cryptobotAsset: process.env.CRYPTOBOT_ASSET ?? "USDT",
    rubToUsdtRate,
    cryptobotPlan30Rub,
    cryptobotPlan90Rub,
    cryptobotPlan180Rub,
    cryptobotDeviceSlotRub,

    workerIntervalSeconds: asInt("WORKER_INTERVAL_SECONDS", process.env.WORKER_INTERVAL_SECONDS ?? "300")
  };
}
