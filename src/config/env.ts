import { URL } from "node:url";
import { EXTRA_DEVICE_RUB } from "../domain/pricing";

type Env = Readonly<{
  nodeEnv: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";

  appHost: string;
  appPort: number;

  databaseUrl: string;
  telegramBotToken: string;
  // Public bot URL shown too users in subscription messages (e.g. when expired).
  telegramBotUrl: string;
  // Reusable Telegram file_id for the bot's brand image (photo).
  botImageFileId?: string;
  adminUsername?: string;
  adminUserIds: ReadonlySet<string>;

  // Public URL of THIS backend (the one that serves GET /sub/<token>).
  backendPublicUrl: string;

  offerVersion: string;

  // Must be localhost-only for security.
  xuiBaseUrl: string;
  xuiUsername: string;
  xuiPassword: string;
  xuiInboundId: number;
  xuiClientFlow?: string;
  xuiEnforceIpLimit: boolean;

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

const LOG_LEVELS: ReadonlySet<Env["logLevel"]> = new Set(["fatal", "error", "warn", "info", "debug", "trace"]);

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

function asIntStrict(name: string, value: string): number {
  const raw = value.trim();
  if (!/^-?\d+$/.test(raw)) throw new Error(`Invalid int env ${name}: ${value}`);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid int env ${name}: ${value}`);
  return parsed;
}

function asNumber(name: string, value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number env ${name}: ${value}`);
  return parsed;
}

function asBoolean(name: string, value: string): boolean {
  const raw = value.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  throw new Error(`Invalid boolean env ${name}: ${value}`);
}

function requirePositiveInt(name: string): number {
  const value = asIntStrict(name, required(name));
  if (value <= 0) throw new Error(`${name} must be > 0 (got: ${value})`);
  return value;
}

function optionalPositiveInt(name: string): number | undefined {
  const raw = optional(name);
  if (raw === undefined) return undefined;
  const value = asIntStrict(name, raw);
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

  const logLevelRaw = (process.env.LOG_LEVEL ?? "info").trim() as Env["logLevel"];
  if (!LOG_LEVELS.has(logLevelRaw)) {
    throw new Error(`Invalid LOG_LEVEL: ${process.env.LOG_LEVEL ?? ""}`);
  }
  const logLevel = logLevelRaw;

  const xuiBaseUrl = ensureUrl("XUI_BASE_URL", required("XUI_BASE_URL"));
  ensureXuiLocalhost(xuiBaseUrl);

  const backendPublicUrl = ensureUrl("BACKEND_PUBLIC_URL", required("BACKEND_PUBLIC_URL"));
  const xuiPort = new URL(xuiBaseUrl).port;
  const backendPort = new URL(backendPublicUrl).port;
  if (backendPort && xuiPort && backendPort === xuiPort) {
    throw new Error("BACKEND_PUBLIC_URL must point to your backend (not 3x-ui). It matches the XUI_BASE_URL port.");
  }

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
  const botImageFileId = optional("BOT_IMAGE_FILE_ID")?.trim() || undefined;

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
    appPort: (() => {
      const port = asIntStrict("APP_PORT", process.env.APP_PORT ?? "3000");
      if (port < 1 || port > 65535) throw new Error(`APP_PORT must be 1..65535 (got: ${port})`);
      return port;
    })(),

    databaseUrl,
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramBotUrl: ensureUrl("TELEGRAM_BOT_URL", required("TELEGRAM_BOT_URL")),
    botImageFileId,
    adminUsername: optional("ADMIN_USERNAME"),
    adminUserIds: parseIdSet(optional("ADMIN_USER_IDS") ?? optional("ADMIN_IDS")),

    backendPublicUrl,

    offerVersion,

    xuiBaseUrl,
    xuiUsername: required("XUI_USERNAME"),
    xuiPassword: required("XUI_PASSWORD"),
    xuiInboundId: requirePositiveInt("XUI_INBOUND_ID"),
    xuiClientFlow: optional("XUI_CLIENT_FLOW"),
    xuiEnforceIpLimit: process.env.XUI_ENFORCE_IP_LIMIT
      ? asBoolean("XUI_ENFORCE_IP_LIMIT", process.env.XUI_ENFORCE_IP_LIMIT)
      : false,

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

    workerIntervalSeconds: (() => {
      const seconds = asIntStrict("WORKER_INTERVAL_SECONDS", process.env.WORKER_INTERVAL_SECONDS ?? "300");
      if (seconds <= 0) throw new Error(`WORKER_INTERVAL_SECONDS must be > 0 (got: ${seconds})`);
      return seconds;
    })(),
  };
}
