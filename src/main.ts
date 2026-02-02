import { run } from "@grammyjs/runner";
import Fastify from "fastify";
import { loadEnv } from "./config/env";
import { MOBILE_BYPASS_URLS } from "./config/mobileBypass";
import { loadFastServers } from "./config/fastServers";
import * as path from "path";
import { getPrisma } from "./db/prisma";
import { ThreeXUiApiClient } from "./integrations/threeXui/threeXuiApiClient";
import { ThreeXUiService } from "./integrations/threeXui/threeXuiService";
import { SubscriptionService } from "./modules/subscription/subscriptionService";
import { OnboardingService } from "./modules/onboarding/onboardingService";
import { buildBot } from "./bot/bot";
import { YooKassaClient } from "./integrations/yookassa/yooKassaClient";
import { CryptoBotClient } from "./integrations/cryptobot/cryptoBotClient";
import { PaymentService } from "./modules/payments/paymentService";
import { registerWebhooks } from "./http/webhooks";
import { registerSubscriptionRoutes } from "./http/subscription";
import { startSubscriptionWorker } from "./worker/subscriptionWorker";
import { PromoService } from "./modules/promo/promoService";
import { ReferralService } from "./modules/referral/referralService";
import { BanService } from "./modules/ban/banService";
import { AntiAbuseService } from "./modules/antiAbuse/antiAbuseService";
import { AdminUserBanService } from "./modules/admin/userBanService";
import { AdminUserDeletionService } from "./modules/admin/userDeletionService";
import { DeviceService } from "./modules/devices/deviceService";

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = getPrisma();

  // Загружаем быстрые серверы из JSON (graceful degradation если файл отсутствует)
  const fastServersPath = path.resolve(__dirname, "../fast-servers.json");
  const FAST_SERVER_ENTRIES = loadFastServers(fastServersPath);

  const xuiApi = new ThreeXUiApiClient({
    baseUrl: env.xuiBaseUrl,
    username: env.xuiUsername,
    password: env.xuiPassword,
  });
  const xui = new ThreeXUiService(xuiApi);

  const subscriptions = new SubscriptionService(prisma, xui, env.xuiInboundId, env.xuiClientFlow);
  const bans = new BanService(prisma);
  const antiAbuse = new AntiAbuseService(prisma);
  const devices = new DeviceService(prisma);
  const referrals = new ReferralService(prisma, subscriptions, bans, antiAbuse);
  const onboarding = new OnboardingService(prisma, subscriptions, bans, antiAbuse, referrals, env.backendPublicUrl, { offerVersion: env.offerVersion });

  const yookassa =
    env.yookassaShopId && env.yookassaSecretKey
      ? new YooKassaClient({ shopId: env.yookassaShopId, secretKey: env.yookassaSecretKey })
      : undefined;
  const cryptobot = env.cryptobotApiToken ? new CryptoBotClient({ apiToken: env.cryptobotApiToken }) : undefined;

  const payments = new PaymentService(prisma, subscriptions, {
    telegramBotToken: env.telegramBotToken,
    telegramBotUrl: env.telegramBotUrl,
    yookassa,
    cryptobot,
    paymentsReturnUrl: env.paymentsReturnUrl,
    offerVersion: env.offerVersion,
    planRubByDays: {
      30: env.plan30Rub,
      90: env.plan90Rub,
      180: env.plan180Rub,
    },
    cryptobotAsset: env.cryptobotAsset,
    rubToUsdtRate: env.rubToUsdtRate,
    cryptobotPlanRubByDays: {
      30: env.cryptobotPlan30Rub,
      90: env.cryptobotPlan90Rub,
      180: env.cryptobotPlan180Rub,
    },
    cryptobotDeviceSlotRub: env.cryptobotDeviceSlotRub,
  });

  const promos = new PromoService(prisma, { offerVersion: env.offerVersion, bans });
  const adminDeletion = new AdminUserDeletionService(prisma, xui);
  const adminBans = new AdminUserBanService(prisma, xui, env.adminUserIds);

  const bot = buildBot({
    botToken: env.telegramBotToken,
    prisma,
    onboarding,
    subscriptions,
    payments,
    promos,
    referrals,
    devices,
    adminDeletion,
    adminBans,
    bans,
    backendPublicUrl: env.backendPublicUrl,
    telegramBotUrl: env.telegramBotUrl,
    offerVersion: env.offerVersion,
    botImageFileId: env.botImageFileId,
    adminUsername: env.adminUsername,
    adminUserIds: env.adminUserIds,
  });

  const app = Fastify({
    logger: { level: env.logLevel },
  });

  app.get("/healthz", async () => ({ ok: true }));
  await registerWebhooks(app, { webhookToken: env.webhookToken, payments });
  await app.register(async (root) => {
    await registerSubscriptionRoutes(root, {
      prisma,
      subscriptions,
      xui,
      devices,
      backendPublicUrl: env.backendPublicUrl,
      telegramBotUrl: env.telegramBotUrl,
      fastServerUrls: FAST_SERVER_ENTRIES,
      mobileBypassUrls: MOBILE_BYPASS_URLS,
      xuiInboundId: env.xuiInboundId,
      xuiClientFlow: env.xuiClientFlow,
    });
  });

  await app.listen({ host: env.appHost, port: env.appPort });
  startSubscriptionWorker({
    prisma,
    xui,
    intervalSeconds: env.workerIntervalSeconds,
    logger: app.log,
    telegramBotToken: env.telegramBotToken,
    telegramBotUrl: env.telegramBotUrl,
  });
  run(bot);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
