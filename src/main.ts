import { run } from "@grammyjs/runner";
import Fastify from "fastify";
import { loadEnv } from "./config/env";
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
import { UserAdminService } from "./modules/admin/userAdminService";
import { BanService } from "./modules/ban/banService";

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = getPrisma();

  const xuiApi = new ThreeXUiApiClient({
    baseUrl: env.xuiBaseUrl,
    username: env.xuiUsername,
    password: env.xuiPassword,
  });
  const xui = new ThreeXUiService(xuiApi);

  const subscriptions = new SubscriptionService(prisma, xui, env.xuiInboundId, env.xuiClientFlow);
  const bans = new BanService(prisma);
  const referrals = new ReferralService(prisma, subscriptions, bans);
  const onboarding = new OnboardingService(prisma, subscriptions, bans, referrals, env.backendPublicUrl, { offerVersion: env.offerVersion });

  const yookassa =
    env.yookassaShopId && env.yookassaSecretKey
      ? new YooKassaClient({ shopId: env.yookassaShopId, secretKey: env.yookassaSecretKey })
      : undefined;
  const cryptobot = env.cryptobotApiToken ? new CryptoBotClient({ apiToken: env.cryptobotApiToken }) : undefined;

  const payments = new PaymentService(prisma, subscriptions, {
    telegramBotToken: env.telegramBotToken,
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
  const adminUsers = new UserAdminService(prisma, xui);

  const bot = buildBot({
    botToken: env.telegramBotToken,
    prisma,
    onboarding,
    subscriptions,
    payments,
    promos,
    referrals,
    adminUsers,
    bans,
    backendPublicUrl: env.backendPublicUrl,
    telegramBotUrl: env.telegramBotUrl,
    offerVersion: env.offerVersion,
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
      backendPublicUrl: env.backendPublicUrl,
      telegramBotUrl: env.telegramBotUrl,
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
  });
  run(bot);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
