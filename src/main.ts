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
import { startSubscriptionWorker } from "./worker/subscriptionWorker";

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
  const onboarding = new OnboardingService(prisma, subscriptions, env.publicPanelBaseUrl);

  const yookassa =
    env.yookassaShopId && env.yookassaSecretKey
      ? new YooKassaClient({ shopId: env.yookassaShopId, secretKey: env.yookassaSecretKey })
      : undefined;
  const cryptobot = env.cryptobotApiToken ? new CryptoBotClient({ apiToken: env.cryptobotApiToken }) : undefined;

  const payments = new PaymentService(prisma, subscriptions, {
    yookassa,
    cryptobot,
    paymentsReturnUrl: env.paymentsReturnUrl,
    planRubMinorByDays: {
      30: env.plan30RubMinor,
      90: env.plan90RubMinor,
      180: env.plan180RubMinor,
    },
    cryptobotAsset: env.cryptobotAsset,
    cryptobotAmountByDays: {
      30: env.cryptobotPlan30Amount,
      90: env.cryptobotPlan90Amount,
      180: env.cryptobotPlan180Amount,
    },
  });

  const bot = buildBot({
    botToken: env.telegramBotToken,
    prisma,
    onboarding,
    subscriptions,
    payments,
    publicPanelBaseUrl: env.publicPanelBaseUrl,
  });

  const app = Fastify({
    logger: { level: env.logLevel },
  });

  app.get("/healthz", async () => ({ ok: true }));
  await registerWebhooks(app, { webhookToken: env.webhookToken, payments });

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
