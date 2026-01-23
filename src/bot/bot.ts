import { Bot } from "grammy";
import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import { MAIN_KEYBOARD } from "./keyboard";
import { OnboardingService } from "../modules/onboarding/onboardingService";
import { SubscriptionService } from "../modules/subscription/subscriptionService";
import { formatUtc } from "../utils/time";
import type { PaymentService } from "../modules/payments/paymentService";
import { PaymentProvider } from "../db/values";

export type BotDeps = Readonly<{
  botToken: string;
  prisma: PrismaClient;
  onboarding: OnboardingService;
  subscriptions: SubscriptionService;
  payments: PaymentService;
  publicPanelBaseUrl: string;
}>;

export function buildBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.botToken);
  const payKeyboard = new InlineKeyboard()
    .text("30 дней · YooKassa", "pay:yoo:30")
    .text("30 дней · CryptoBot", "pay:cb:30")
    .row()
    .text("90 дней · YooKassa", "pay:yoo:90")
    .text("90 дней · CryptoBot", "pay:cb:90")
    .row()
    .text("180 дней · YooKassa", "pay:yoo:180")
    .text("180 дней · CryptoBot", "pay:cb:180");

  const deviceKeyboard = new InlineKeyboard()
    .text("+1 (50 ₽) · YooKassa", "device:yoo")
    .text("+1 · CryptoBot", "device:cb");

  bot.command("start", async (ctx) => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);
    const result = await deps.onboarding.handleStart(telegramId);

    const lines: string[] = [];
    lines.push("VPNYS — VPN на базе Xray (VLESS + Reality).");
    if (result.isTrialGrantedNow) lines.push("TRIAL активирован: 7 дней.");
    if (result.expiresAt) lines.push(`Подписка до: ${formatUtc(result.expiresAt)}`);
    lines.push("");
    lines.push("Меню ниже.");

    await ctx.reply(lines.join("\n"), { reply_markup: MAIN_KEYBOARD });
  });

  bot.hears("🔐 Подключить VPN", async (ctx) => {
    if (!ctx.from?.id) return;
    const user = await deps.prisma.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!user) return await ctx.reply("Сначала нажмите /start.", { reply_markup: MAIN_KEYBOARD });

    const state = await deps.subscriptions.syncFromXui(user);
    const url = deps.subscriptions.subscriptionUrl(deps.publicPanelBaseUrl, state.subscription.xuiSubscriptionId);

    if (state.expiresAt && state.expiresAt.getTime() <= Date.now()) {
      return await ctx.reply(`Подписка истекла. Оплатите для продления.\n\nСсылка: ${url}`, { reply_markup: MAIN_KEYBOARD });
    }

    return await ctx.reply(`Ссылка подписки (не хранится в боте):\n${url}`, { reply_markup: MAIN_KEYBOARD });
  });

  bot.hears("⏳ Моя подписка", async (ctx) => {
    if (!ctx.from?.id) return;
    const user = await deps.prisma.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!user) return await ctx.reply("Сначала нажмите /start.", { reply_markup: MAIN_KEYBOARD });

    const state = await deps.subscriptions.syncFromXui(user);
    const url = deps.subscriptions.subscriptionUrl(deps.publicPanelBaseUrl, state.subscription.xuiSubscriptionId);
    const expiresLine = state.expiresAt ? `До: ${formatUtc(state.expiresAt)}` : "Срок не установлен.";
    const enabledLine = state.enabled ? "Статус: включено" : "Статус: отключено";

    return await ctx.reply([expiresLine, enabledLine, "", `Subscription URL:\n${url}`].join("\n"), {
      reply_markup: MAIN_KEYBOARD,
    });
  });

  bot.hears("💳 Оплатить", async (ctx) => {
    return await ctx.reply("Выберите тариф:", { reply_markup: payKeyboard });
  });

  bot.callbackQuery(/^pay:(yoo|cb):(30|90|180)$/, async (ctx) => {
    if (!ctx.from?.id) return;
    const providerRaw = ctx.match[1];
    const planDays = Number(ctx.match[2]) as 30 | 90 | 180;
    const provider = providerRaw === "yoo" ? "YOOKASSA" : "CRYPTOBOT";

    await ctx.answerCallbackQuery();
    try {
      const created = await deps.payments.createCheckout({
        telegramId: String(ctx.from.id),
        provider,
        planDays,
      });
      await ctx.reply(`Ссылка для оплаты:\n${created.payUrl}`);
    } catch (e: any) {
      await ctx.reply(`Не удалось создать оплату: ${e?.message ?? String(e)}`, { reply_markup: MAIN_KEYBOARD });
    }
  });

  bot.hears("👥 Реферальная программа", async (ctx) => {
    return await ctx.reply("Реферальная программа: скоро.", { reply_markup: MAIN_KEYBOARD });
  });

  bot.hears("ℹ️ О сервисе", async (ctx) => {
    return await ctx.reply(
      [
        "Сервис: коммерческий VPN через 3x-ui + Xray (VLESS + Reality).",
        "В боте не храним VPN-конфиги и не генерируем их.",
        "Источник истины по подписке — expiration_date в 3x-ui.",
      ].join("\n"),
      { reply_markup: MAIN_KEYBOARD },
    );
  });

  bot.hears(/Устройства/, async (ctx) => {
    if (!ctx.from?.id) return;
    const user = await deps.prisma.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!user) return await ctx.reply("РЎРЅР°С‡Р°Р»Р° РЅР°Р¶РјРёС‚Рµ /start.", { reply_markup: MAIN_KEYBOARD });

    const sub = await deps.subscriptions.ensureForUser(user);

    await ctx.reply(
      [`Текущий лимит устройств: ${sub.deviceLimit}`, "Стоимость следующего устройства: +50 ₽"].join("\n"),
      { reply_markup: deviceKeyboard },
    );
  });

  bot.callbackQuery(/^device:(yoo|cb)$/, async (ctx) => {
    if (!ctx.from?.id) return;
    const providerRaw = ctx.match[1];
    const provider = providerRaw === "yoo" ? PaymentProvider.YOOKASSA : PaymentProvider.CRYPTOBOT;

    await ctx.answerCallbackQuery();
    try {
      const created = await deps.payments.createDeviceSlotCheckout({
        telegramId: String(ctx.from.id),
        provider,
      });
      await ctx.reply(`Ссылка для оплаты (+1 устройство):\n${created.payUrl}`);
    } catch (e: any) {
      await ctx.reply(`Не удалось создать оплату: ${e?.message ?? String(e)}`, { reply_markup: MAIN_KEYBOARD });
    }
  });

  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Bot error", err);
  });

  return bot;
}
