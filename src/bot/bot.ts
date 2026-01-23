import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { PrismaClient } from "@prisma/client";
import path from "node:path";
import { MAIN_KEYBOARD } from "./keyboard";
import type { OnboardingService } from "../modules/onboarding/onboardingService";
import type { SubscriptionService } from "../modules/subscription/subscriptionService";
import type { PaymentService } from "../modules/payments/paymentService";
import { formatUtc } from "../utils/time";
import { PaymentProvider } from "../db/values";
import { MAX_DEVICE_LIMIT, MIN_DEVICE_LIMIT } from "../domain/deviceLimits";
import { escapeHtml, formatDevices, formatRubMinor } from "./ui";

export type BotDeps = Readonly<{
  botToken: string;
  prisma: PrismaClient;
  onboarding: OnboardingService;
  subscriptions: SubscriptionService;
  payments: PaymentService;
  publicPanelBaseUrl: string;
  adminUsername?: string;
}>;

type ReplyOpts = any;

async function replyOrEdit(ctx: any, text: string, opts: ReplyOpts = {}): Promise<void> {
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { ...opts, disable_web_page_preview: true });
      return;
    }
  } catch {
    // fall back to reply
  }
  await ctx.reply(text, { ...opts, disable_web_page_preview: true });
}

function cabinetKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔐 Моя подписка", "nav:sub")
    .text("💳 Оплатить", "nav:pay")
    .row()
    .text("📱 Устройства", "nav:devices")
    .text("🧾 Инструкция", "nav:guide")
    .row()
    .text("✉️ Написать админу", "nav:admin");
}

function backToCabinetKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔙 Назад", "nav:cabinet");
}

export function buildBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.botToken);

  const showCabinet = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);
    const user = await deps.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      await replyOrEdit(ctx, "Сначала нажми /start — и я всё настрою 👇", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    const subscription = await deps.subscriptions.ensureForUser(user);

    const now = Date.now();
    const active = !!subscription.expiresAt && subscription.expiresAt.getTime() > now && subscription.enabled;

    const name = escapeHtml([ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || ctx.from.username || "друг");

    const statusLine = active ? "✅ Подписка: активна" : "❌ Подписка: нет (или закончилась)";
    const expiresLine = subscription.expiresAt ? `⏳ До: <b>${escapeHtml(formatUtc(subscription.expiresAt))}</b>` : "⏳ До: <b>не задано</b>";
    const devicesLine = `📱 Устройства: <b>${escapeHtml(formatDevices(subscription.deviceLimit))}</b>`;

    const text = [
      `👤 <b>Личный кабинет</b>`,
      "",
      `Привет, <b>${name}</b>!`,
      `ID: <code>${escapeHtml(telegramId)}</code>`,
      "",
      statusLine,
      active ? expiresLine : "",
      devicesLine,
      "",
      "Выбирай, что делаем дальше 👇",
    ]
      .filter(Boolean)
      .join("\n");

    if (!ctx.callbackQuery) {
      const photoPath = path.join(process.cwd(), "imag", "lis.png");
      try {
        await ctx.replyWithPhoto(new InputFile(photoPath));
      } catch {
        // if file missing in runtime, just skip photo
      }

      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: cabinetKeyboard(),
        disable_web_page_preview: true,
      });
      return;
    }

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: cabinetKeyboard() });
  };

  const showMySubscription = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);
    const user = await deps.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      await replyOrEdit(ctx, "Сначала нажми /start — и я всё настрою 👇", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    const state = await deps.subscriptions.syncFromXui(user);
    const sub = state.subscription;

    const active = !!state.expiresAt && state.expiresAt.getTime() > Date.now() && state.enabled;
    const status = active ? "✅ Активна" : "❌ Не активна";
    const expires = state.expiresAt ? formatUtc(state.expiresAt) : "не задано";

    const url = deps.subscriptions.subscriptionUrl(deps.publicPanelBaseUrl, sub.xuiSubscriptionId);

    const text = [
      "🔐 <b>Моя подписка</b>",
      "",
      `Статус: <b>${escapeHtml(status)}</b>`,
      `До: <b>${escapeHtml(expires)}</b>`,
      `Устройства: <b>${escapeHtml(formatDevices(sub.deviceLimit))}</b>`,
      "",
      "Ссылка (просто скопируй и вставь в приложение):",
      `<code>${escapeHtml(url)}</code>`,
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("📋 Скопировать ссылку", "sub:copy")
      .row()
      .text("🧾 Инструкция", "nav:guide")
      .text("🔙 Назад", "nav:cabinet");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showPayStep1 = async (ctx: any): Promise<void> => {
    const kb = new InlineKeyboard()
      .text("30 дней", "pay:term:30")
      .text("90 дней", "pay:term:90")
      .text("180 дней", "pay:term:180")
      .row()
      .text("🔙 Назад", "nav:cabinet");

    await replyOrEdit(ctx, "Выбери срок подписки 🗓️", { reply_markup: kb });
  };

  const showPayStep2 = async (ctx: any, planDays: 30 | 90 | 180, deviceLimit: number): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quote: Awaited<ReturnType<PaymentService["quoteSubscription"]>>;
    try {
      quote = await deps.payments.quoteSubscription({ telegramId, planDays, deviceLimit });
    } catch (e: any) {
      await replyOrEdit(ctx, `Не получилось посчитать цену: ${e?.message ?? String(e)}`, { reply_markup: backToCabinetKeyboard() });
      return;
    }

    const chosen = quote.selectedDeviceLimit;
    const base = formatRubMinor(quote.baseRubMinor);
    const extra = formatRubMinor(quote.extraDeviceRubMinor);
    const total = formatRubMinor(quote.totalRubMinor);

    const text = [
      "⚙️ <b>Настрой тариф</b>",
      "",
      `Срок: <b>${planDays} дней</b>`,
      `Базово: ${MIN_DEVICE_LIMIT} устройство`,
      `Сейчас выбрано: <b>${chosen}</b>`,
      `Цена: <b>${escapeHtml(total)}</b>`,
      "",
      `1 устройство = ${escapeHtml(base)}`,
      `+1 устройство = +${escapeHtml(extra)} (максимум ${MAX_DEVICE_LIMIT})`,
    ].join("\n");

    const kb = new InlineKeyboard();
    for (let i = MIN_DEVICE_LIMIT; i <= MAX_DEVICE_LIMIT; i++) {
      kb.text(`${i} ${i === 1 ? "устройство" : "устройства"}`, `pay:dev:${planDays}:${i}`);
      if (i % 3 === 0) kb.row();
    }
    kb.row().text(`💳 Оплатить ${total}`, `pay:go:${planDays}:${chosen}`);
    kb.row().text("🔙 Назад", "pay:back:term");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showPayStep3 = async (ctx: any, planDays: 30 | 90 | 180, deviceLimit: number): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);
    let quote: Awaited<ReturnType<PaymentService["quoteSubscription"]>>;
    try {
      quote = await deps.payments.quoteSubscription({ telegramId, planDays, deviceLimit });
    } catch (e: any) {
      await replyOrEdit(ctx, `Не получилось посчитать цену: ${e?.message ?? String(e)}`, { reply_markup: backToCabinetKeyboard() });
      return;
    }

    const total = formatRubMinor(quote.totalRubMinor);

    const text = [`Выбери способ оплаты 💰`, "", `Сумма: <b>${escapeHtml(total)}</b>`].join("\n");

    const kb = new InlineKeyboard()
      .text("₽ Рубли (YooKassa)", `pay:do:yoo:${planDays}:${quote.selectedDeviceLimit}`)
      .text("$ Крипта (CryptoBot)", `pay:do:cb:${planDays}:${quote.selectedDeviceLimit}`)
      .row()
      .text("🔙 Назад", `pay:dev:${planDays}:${quote.selectedDeviceLimit}`);

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showDevices = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);
    let quoted: Awaited<ReturnType<PaymentService["quoteDeviceSlot"]>>;
    try {
      quoted = await deps.payments.quoteDeviceSlot({ telegramId });
    } catch (e: any) {
      await replyOrEdit(ctx, "Сначала нажми /start — и я всё настрою 👇", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    const textLines = [
      "📱 <b>Устройства</b>",
      "",
      `Текущее: <b>${escapeHtml(formatDevices(quoted.currentDeviceLimit))}</b>`,
    ];

    const kb = new InlineKeyboard();

    if (quoted.canAdd) {
      textLines.push(`Следующее устройство: <b>+${escapeHtml(formatRubMinor(quoted.priceRubMinor))}</b>`);
      kb.text(`➕ Добавить устройство (+${formatRubMinor(quoted.priceRubMinor)})`, "dev:add").row();
    } else {
      textLines.push("🚫 Достигнут максимальный лимит устройств");
    }

    kb.text("🔙 Назад", "nav:cabinet");

    await replyOrEdit(ctx, textLines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
  };

  const showDevicePayMethod = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);
    let quoted: Awaited<ReturnType<PaymentService["quoteDeviceSlot"]>>;
    try {
      quoted = await deps.payments.quoteDeviceSlot({ telegramId });
    } catch {
      await replyOrEdit(ctx, "Сначала нажми /start — и я всё настрою 👇", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    if (!quoted.canAdd) {
      await replyOrEdit(ctx, "🚫 Уже максимум устройств. Больше не влезет 🧱", { reply_markup: backToCabinetKeyboard() });
      return;
    }

    const text = [`Выбери способ оплаты 💰`, "", `+1 устройство: <b>${escapeHtml(formatRubMinor(quoted.priceRubMinor))}</b>`].join("\n");

    const kb = new InlineKeyboard()
      .text("₽ Рубли (YooKassa)", "dev:do:yoo")
      .text("$ Крипта (CryptoBot)", "dev:do:cb")
      .row()
      .text("🔙 Назад", "nav:devices");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showGuideMenu = async (ctx: any): Promise<void> => {
    const kb = new InlineKeyboard()
      .text("Android", "guide:android")
      .text("iOS", "guide:ios")
      .row()
      .text("Windows / macOS", "guide:desktop")
      .row()
      .text("🔙 Назад", "nav:cabinet");

    await replyOrEdit(ctx, "🧾 Инструкция: выбери устройство", { reply_markup: kb });
  };

  const showGuide = async (ctx: any, platform: "android" | "ios" | "desktop"): Promise<void> => {
    const title = platform === "android" ? "Android" : platform === "ios" ? "iOS" : "Windows / macOS";

    const steps =
      platform === "android"
        ? [
            "1) Скачай приложение <b>Hiddify</b> или <b>v2rayNG</b>",
            "2) Нажми: “Добавить подписку”",
            "3) Вставь ссылку из «Моя подписка»",
            "4) Нажми “Подключить” — и ты в домике 🦊",
          ]
        : platform === "ios"
          ? [
              "1) Скачай приложение <b>Hiddify</b>",
              "2) Нажми: “Добавить подписку”",
              "3) Вставь ссылку из «Моя подписка»",
              "4) Нажми “Подключить” — поехали 🚀",
            ]
          : [
              "1) Скачай <b>Hiddify</b> для ПК",
              "2) Вставь ссылку из «Моя подписка»",
              "3) Нажми “Подключить”",
              "4) Готово. VPN включён — жизнь хороша 😎",
            ];

    const text = [
      `🧾 <b>Инструкция · ${title}</b>`,
      "",
      ...steps,
      "",
      "Если что-то не получается — жми «Написать админу» (он иногда кусается, но помогает).",
    ].join("\n");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard() });
  };

  const showAbout = async (ctx: any): Promise<void> => {
    const text = [
      "🦊 <b>ЛисVPN</b> — быстрый и хитрый VPN.",
      "Работает там, где другие падают.",
      "Без боли. Просто включил — и поехали.",
      "",
      "Никаких конфигов в боте — только удобная ссылка.",
    ].join("\n");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard() });
  };

  const showAdmin = async (ctx: any): Promise<void> => {
    const username = deps.adminUsername?.replace(/^@/, "");
    if (!username) {
      await replyOrEdit(ctx, "Админ пока не настроен 😅\n(нужно задать ADMIN_USERNAME)", { reply_markup: backToCabinetKeyboard() });
      return;
    }

    const kb = new InlineKeyboard()
      .url("✉️ Открыть чат с админом", `https://t.me/${encodeURIComponent(username)}`)
      .row()
      .text("🔙 Назад", "nav:cabinet");

    await replyOrEdit(ctx, `Напиши админу: <b>@${escapeHtml(username)}</b>`, { parse_mode: "HTML", reply_markup: kb });
  };

  bot.command("start", async (ctx) => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    const result = await deps.onboarding.handleStart(telegramId);

    const lines: string[] = [];
    lines.push("🦊 Привет! Я ЛисVPN. Я помогу тебе быть в интернете как ниндзя.");
    if (result.isTrialGrantedNow) lines.push("🎁 Тест-драйв включён: 7 дней (1 устройство). ");
    if (result.expiresAt) lines.push(`⏳ Подписка до: ${formatUtc(result.expiresAt)}`);
    lines.push("\nЖми кнопки внизу 👇");

    await ctx.reply(lines.join("\n"), { reply_markup: MAIN_KEYBOARD });
  });

  bot.hears("👤 Личный кабинет", showCabinet);
  bot.hears("🔐 Моя подписка", showMySubscription);
  bot.hears("💳 Оплатить", showPayStep1);
  bot.hears("🧾 Инструкция", showGuideMenu);
  bot.hears("ℹ️ О сервисе", showAbout);

  bot.callbackQuery("nav:cabinet", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCabinet(ctx);
  });
  bot.callbackQuery("nav:sub", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMySubscription(ctx);
  });
  bot.callbackQuery("nav:pay", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPayStep1(ctx);
  });
  bot.callbackQuery("nav:devices", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDevices(ctx);
  });
  bot.callbackQuery("nav:guide", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGuideMenu(ctx);
  });
  bot.callbackQuery("nav:admin", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showAdmin(ctx);
  });

  bot.callbackQuery(/^pay:term:(30|90|180)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    await showPayStep2(ctx, days, MIN_DEVICE_LIMIT);
  });

  bot.callbackQuery(/^pay:dev:(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    const devices = Number(ctx.match[2]);
    await showPayStep2(ctx, days, devices);
  });

  bot.callbackQuery(/^pay:go:(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    const devices = Number(ctx.match[2]);
    await showPayStep3(ctx, days, devices);
  });

  bot.callbackQuery("pay:back:term", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPayStep1(ctx);
  });

  bot.callbackQuery(/^pay:do:(yoo|cb):(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from?.id) return;

    const providerRaw = ctx.match[1];
    const provider = providerRaw === "yoo" ? PaymentProvider.YOOKASSA : PaymentProvider.CRYPTOBOT;
    const planDays = Number(ctx.match[2]) as 30 | 90 | 180;
    const deviceLimit = Number(ctx.match[3]);

    try {
      const created = await deps.payments.createSubscriptionCheckout({
        telegramId: String(ctx.from.id),
        provider,
        planDays,
        deviceLimit,
      });

      const text = [
        "✅ Почти готово!",
        "",
        "Открой ссылку и оплати 👇",
        created.payUrl,
        "",
        "После оплаты я сам всё обновлю.",
      ].join("\n");

      await replyOrEdit(ctx, text, { reply_markup: backToCabinetKeyboard() });
    } catch (e: any) {
      await replyOrEdit(ctx, `Не удалось создать оплату: ${e?.message ?? String(e)}`, { reply_markup: backToCabinetKeyboard() });
    }
  });

  bot.callbackQuery("dev:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDevicePayMethod(ctx);
  });

  bot.callbackQuery(/^dev:do:(yoo|cb)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from?.id) return;

    const providerRaw = ctx.match[1];
    const provider = providerRaw === "yoo" ? PaymentProvider.YOOKASSA : PaymentProvider.CRYPTOBOT;

    try {
      const created = await deps.payments.createDeviceSlotCheckout({
        telegramId: String(ctx.from.id),
        provider,
      });

      const text = [
        "📱 +1 устройство",
        "",
        "Открой ссылку и оплати 👇",
        created.payUrl,
        "",
        "После оплаты лимит устройств увеличится автоматически.",
      ].join("\n");

      await replyOrEdit(ctx, text, { reply_markup: backToCabinetKeyboard() });
    } catch (e: any) {
      await replyOrEdit(ctx, `Не удалось создать оплату: ${e?.message ?? String(e)}`, { reply_markup: backToCabinetKeyboard() });
    }
  });

  bot.callbackQuery(/^guide:(android|ios|desktop)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGuide(ctx, ctx.match[1] as any);
  });

  bot.callbackQuery("sub:copy", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Лови ссылку 👇", show_alert: false });
    if (!ctx.from?.id) return;
    const user = await deps.prisma.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!user) return;

    const sub = await deps.subscriptions.ensureForUser(user);
    const url = deps.subscriptions.subscriptionUrl(deps.publicPanelBaseUrl, sub.xuiSubscriptionId);

    await ctx.reply(url, { reply_markup: MAIN_KEYBOARD, disable_web_page_preview: true });
  });

  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Bot error", err);
  });

  return bot;
}
