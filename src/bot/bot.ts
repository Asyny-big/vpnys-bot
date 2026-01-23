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

type Support = Readonly<{
  url?: string;
}>;

function support(deps: BotDeps): Support {
  const username = deps.adminUsername?.replace(/^@/, "");
  if (!username) return {};
  return { url: `https://t.me/${encodeURIComponent(username)}` };
}

function supportButton(deps: BotDeps, label = "🆘 Поддержка"): InlineKeyboard {
  const sup = support(deps);
  if (sup.url) return new InlineKeyboard().url(label, sup.url);
  return new InlineKeyboard().text(label, "nav:support");
}

function backToCabinetKeyboard(deps: BotDeps): InlineKeyboard {
  return new InlineKeyboard().text("🔙 Назад", "nav:cabinet").row().add(supportButton(deps));
}

async function replyOrEdit(ctx: any, text: string, opts: ReplyOpts = {}): Promise<void> {
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { ...opts, link_preview_options: { is_disabled: true } });
      return;
    }
  } catch {
    // fall back to reply
  }
  await ctx.reply(text, { ...opts, link_preview_options: { is_disabled: true } });
}

function cabinetKeyboard(deps: BotDeps): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("🔐 Моя подписка", "nav:sub")
    .text("💳 Оформить подписку", "nav:buy")
    .row()
    .text("📱 Устройства", "nav:devices")
    .text("🧾 Инструкция", "nav:guide")
    .row()
    .text("🆘 Написать в поддержку", "nav:support");

  const sup = support(deps);
  if (sup.url) {
    return new InlineKeyboard()
      .text("🔐 Моя подписка", "nav:sub")
      .text("💳 Оформить подписку", "nav:buy")
      .row()
      .text("📱 Устройства", "nav:devices")
      .text("🧾 Инструкция", "nav:guide")
      .row()
      .url("🆘 Написать в поддержку", sup.url);
  }

  return kb;
}

export function buildBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.botToken);
  const inFlight = new Map<string, number>();
  const inflightTtlMs = 30_000;

  const lock = (key: string): boolean => {
    const now = Date.now();
    for (const [k, startedAt] of inFlight) {
      if (now - startedAt > inflightTtlMs) inFlight.delete(k);
    }
    if (inFlight.has(key)) return false;
    inFlight.set(key, now);
    return true;
  };

  const unlock = (key: string): void => {
    inFlight.delete(key);
  };

  const showSupport = async (ctx: any): Promise<void> => {
    const username = deps.adminUsername?.replace(/^@/, "");
    if (!username) {
      await replyOrEdit(ctx, "Поддержка пока не настроена. Но мы рядом.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const url = `https://t.me/${encodeURIComponent(username)}`;
    const text = [`Напиши нам сюда 👇`, url].join("\n");

    const kb = new InlineKeyboard().url("🆘 Открыть чат", url).row().text("🔙 Назад", "nav:cabinet");
    await replyOrEdit(ctx, text, { reply_markup: kb });
  };

  const requireUser = async (ctx: any): Promise<{ telegramId: string; user: any } | null> => {
    if (!ctx.from?.id) return null;
    const telegramId = String(ctx.from.id);
    const user = await deps.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      await replyOrEdit(ctx, "Нажми /start. Я всё настрою за секунду.", { reply_markup: MAIN_KEYBOARD });
      return null;
    }
    return { telegramId, user };
  };

  const showCabinet = async (ctx: any): Promise<void> => {
    const required = await requireUser(ctx);
    if (!required) return;

    const { telegramId, user } = required;
    const subscription = await deps.subscriptions.ensureForUser(user);

    const active = !!subscription.expiresAt && subscription.expiresAt.getTime() > Date.now() && subscription.enabled;

    const name = escapeHtml([ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || ctx.from.username || "друг");

    const statusLine = active ? "✅ Подписка активна" : "❌ Подписки нет";
    const expiresLine = active && subscription.expiresAt ? `⏳ До: <b>${escapeHtml(formatUtc(subscription.expiresAt))}</b>` : "";
    const devicesLine = `📱 Устройства: <b>${escapeHtml(formatDevices(subscription.deviceLimit))}</b>`;

    const text = [
      "👤 <b>Личный кабинет</b>",
      "",
      `Привет, <b>${name}</b>`,
      `Твой ID: <code>${escapeHtml(telegramId)}</code>`,
      "",
      statusLine,
      expiresLine,
      devicesLine,
      "",
      "Жми кнопку и поехали 🦊",
    ]
      .filter(Boolean)
      .join("\n");

    if (!ctx.callbackQuery) {
      const photoPath = path.join(process.cwd(), "imag", "lis.png");
      try {
        await ctx.replyWithPhoto(new InputFile(photoPath));
      } catch {
        // ignore
      }

      await ctx.reply(text, { parse_mode: "HTML", reply_markup: cabinetKeyboard(deps), link_preview_options: { is_disabled: true } });
      return;
    }

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: cabinetKeyboard(deps) });
  };

  const showMySubscription = async (ctx: any): Promise<void> => {
    const required = await requireUser(ctx);
    if (!required) return;

    const { user } = required;
    const state = await deps.subscriptions.syncFromXui(user);
    const sub = state.subscription;

    const active = !!state.expiresAt && state.expiresAt.getTime() > Date.now() && state.enabled;
    const status = active ? "✅ Активна" : "❌ Не активна";
    const expires = state.expiresAt ? formatUtc(state.expiresAt) : "";

    const url = deps.subscriptions.subscriptionUrl(deps.publicPanelBaseUrl, sub.xuiSubscriptionId);

    const text = [
      "🔐 <b>Моя подписка</b>",
      "",
      `Статус: <b>${escapeHtml(status)}</b>`,
      expires ? `До: <b>${escapeHtml(expires)}</b>` : "",
      `Устройства: <b>${escapeHtml(formatDevices(sub.deviceLimit))}</b>`,
      "",
      "Твоя VPN ссылка 👇",
      `<code>${escapeHtml(url)}</code>`,
    ]
      .filter(Boolean)
      .join("\n");

    const kb = new InlineKeyboard()
      .text("📋 Скопировать", "sub:copy")
      .row()
      .text("🧾 Инструкция", "nav:guide")
      .text("🔙 Назад", "nav:cabinet")
      .row()
      .add(supportButton(deps, "🆘 Написать в поддержку"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showDevices = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quoted: any;
    try {
      quoted = await deps.payments.quoteDeviceSlot({ telegramId });
    } catch {
      await replyOrEdit(ctx, "Нажми /start. Я всё настрою за секунду.", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    const textLines = [
      "📱 <b>Устройства</b>",
      "",
      `Сейчас: <b>${escapeHtml(formatDevices(quoted.currentDeviceLimit))}</b>`,
    ];

    const kb = new InlineKeyboard();

    if (quoted.canAdd) {
      textLines.push(`Следующее: <b>+${escapeHtml(formatRubMinor(quoted.priceRubMinor))}</b>`);
      kb.text(`➕ Добавить за ${formatRubMinor(quoted.priceRubMinor)}`, "dev:pay").row();
    } else {
      textLines.push("🚫 Упёрлись в максимум. Больше не влезет.");
    }

    kb.text("🔙 Назад", "nav:cabinet").row().add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, textLines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
  };

  const showDevicePayMethod = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quoted: any;
    try {
      quoted = await deps.payments.quoteDeviceSlot({ telegramId });
    } catch {
      await replyOrEdit(ctx, "Нажми /start. Я всё настрою за секунду.", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    if (!quoted.canAdd) {
      await replyOrEdit(ctx, "🚫 Уже максимум устройств.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const text = ["Выбери, чем платим 💰", "", `+1 устройство: <b>${escapeHtml(formatRubMinor(quoted.priceRubMinor))}</b>`].join("\n");

    const kb = new InlineKeyboard()
      .text("₽ Рубли", "dev:do:yoo")
      .text("$ Крипта", "dev:do:cb")
      .row()
      .text("🔙 Назад", "nav:devices")
      .row()
      .add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showBuyConfig = async (ctx: any, planDays: 30 | 90 | 180, deviceLimit: number): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quote: any;
    try {
      quote = await deps.payments.quoteSubscription({ telegramId, planDays, deviceLimit });
    } catch (e: any) {
      await replyOrEdit(ctx, `Не получилось посчитать цену: ${e?.message ?? String(e)}`, { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const chosenDevices = quote.selectedDeviceLimit;
    const total = formatRubMinor(quote.totalRubMinor);

    const text = [
      "🦊 Оформляем подписку",
      "",
      "Сколько устройств подключаем",
      `Сейчас: <b>${escapeHtml(formatDevices(chosenDevices))}</b>`,
      `Срок: <b>${planDays} дней</b>`,
      "",
      `${chosenDevices} устройств — ${escapeHtml(total)}`,
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("➖", `buy:dev:dec:${planDays}:${chosenDevices}`)
      .text(`${chosenDevices}`, `buy:dev:noop:${planDays}:${chosenDevices}`)
      .text("➕", `buy:dev:inc:${planDays}:${chosenDevices}`)
      .row();

    for (let i = MIN_DEVICE_LIMIT; i <= MAX_DEVICE_LIMIT; i++) {
      kb.text(`${i}`, `buy:cfg:${planDays}:${i}`);
      if (i % 6 === 0) kb.row();
    }

    kb.row()
      .text("30 дней", `buy:cfg:30:${chosenDevices}`)
      .text("90 дней", `buy:cfg:90:${chosenDevices}`)
      .text("180 дней", `buy:cfg:180:${chosenDevices}`);

    kb.row().text(`Оплатить ${total}`, `buy:pay:${planDays}:${chosenDevices}`);
    kb.row().text("🔙 Назад", "nav:cabinet");
    kb.row().add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showBuyMethod = async (ctx: any, planDays: 30 | 90 | 180, deviceLimit: number): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quote: any;
    try {
      quote = await deps.payments.quoteSubscription({ telegramId, planDays, deviceLimit });
    } catch (e: any) {
      await replyOrEdit(ctx, `Не получилось посчитать цену: ${e?.message ?? String(e)}`, { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const total = formatRubMinor(quote.totalRubMinor);

    const text = ["Выбери, чем платим 💰", "", `Сумма: <b>${escapeHtml(total)}</b>`, `Срок: <b>${planDays} дней</b>`, `Устройства: <b>${escapeHtml(formatDevices(quote.selectedDeviceLimit))}</b>`].join("\n");

    const kb = new InlineKeyboard()
      .text("₽ Рубли", `buy:do:yoo:${planDays}:${quote.selectedDeviceLimit}`)
      .text("$ Крипта", `buy:do:cb:${planDays}:${quote.selectedDeviceLimit}`)
      .row()
      .text("🔙 Назад", `buy:cfg:${planDays}:${quote.selectedDeviceLimit}`)
      .row()
      .add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showGuideMenu = async (ctx: any): Promise<void> => {
    const kb = new InlineKeyboard()
      .text("Android", "guide:android")
      .text("iPhone", "guide:ios")
      .row()
      .text("Windows и Mac", "guide:desktop")
      .row()
      .text("🔙 Назад", "nav:cabinet")
      .row()
      .add(supportButton(deps));

    await replyOrEdit(ctx, "🧾 Инструкция. Выбери устройство", { reply_markup: kb });
  };

  const showGuide = async (ctx: any, platform: "android" | "ios" | "desktop"): Promise<void> => {
    const title = platform === "android" ? "Android" : platform === "ios" ? "iPhone" : "Windows и Mac";

    const steps =
      platform === "android"
        ? [
            "1. Скачай Hiddify или v2rayNG",
            "2. Открой приложение и добавь подписку",
            "3. Вставь VPN ссылку из раздела Моя подписка",
            "4. Нажми Подключить и радуйся",
          ]
        : platform === "ios"
          ? [
              "1. Скачай Hiddify",
              "2. Добавь подписку",
              "3. Вставь VPN ссылку из раздела Моя подписка",
              "4. Нажми Подключить",
            ]
          : [
              "1. Скачай Hiddify",
              "2. Вставь VPN ссылку из раздела Моя подписка",
              "3. Нажми Подключить",
              "4. Готово",
            ];

    const text = [`🧾 <b>Инструкция. ${escapeHtml(title)}</b>`, "", ...steps, "", "Если что-то не так, жми Поддержка."].join("\n");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
  };

  const showAbout = async (ctx: any): Promise<void> => {
    const text = [
      "🦊 <b>ЛисVPN</b>",
      "Интернет без нервов.",
      "Включил и поехали.",
      "",
      "Если что-то глючит, мы рядом.",
    ].join("\n");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
  };

  bot.command("start", async (ctx) => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    const result = await deps.onboarding.handleStart(telegramId);

    const lines: string[] = [];
    lines.push("ЛисVPN 🦊. Интернет без нервов.");
    if (result.isTrialGrantedNow) lines.push("Подарок включён. 7 дней. 1 устройство.");
    if (result.expiresAt) lines.push(`Подписка до ${formatUtc(result.expiresAt)}`);
    lines.push("Жми Личный кабинет и забирай ссылку 👇");

    await ctx.reply(lines.join("\n"), { reply_markup: MAIN_KEYBOARD, link_preview_options: { is_disabled: true } });
  });

  bot.hears("👤 Личный кабинет", showCabinet);
  bot.hears("🔐 Моя подписка", showMySubscription);
  bot.hears("💳 Оформить подписку", (ctx) => showBuyConfig(ctx, 30, MIN_DEVICE_LIMIT));
  bot.hears("🧾 Инструкция", showGuideMenu);
  bot.hears("ℹ️ О сервисе", showAbout);
  bot.hears("🆘 Написать в поддержку", showSupport);

  bot.callbackQuery("nav:cabinet", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCabinet(ctx);
  });
  bot.callbackQuery("nav:sub", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMySubscription(ctx);
  });
  bot.callbackQuery("nav:buy", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showBuyConfig(ctx, 30, MIN_DEVICE_LIMIT);
  });
  bot.callbackQuery("nav:devices", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDevices(ctx);
  });
  bot.callbackQuery("nav:guide", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGuideMenu(ctx);
  });
  bot.callbackQuery("nav:support", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSupport(ctx);
  });

  bot.callbackQuery(/^buy:cfg:(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    const devices = Number(ctx.match[2]);
    await showBuyConfig(ctx, days, devices);
  });

  bot.callbackQuery(/^buy:dev:(inc|dec|noop):(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match[1] as "inc" | "dec" | "noop";
    const days = Number(ctx.match[2]) as 30 | 90 | 180;
    const devices = Number(ctx.match[3]);

    if (action === "noop") {
      await showBuyConfig(ctx, days, devices);
      return;
    }

    const next = action === "inc" ? devices + 1 : devices - 1;
    await showBuyConfig(ctx, days, next);
  });

  bot.callbackQuery(/^buy:pay:(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    const devices = Number(ctx.match[2]);
    await showBuyMethod(ctx, days, devices);
  });

  bot.callbackQuery(/^buy:do:(yoo|cb):(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from?.id) return;

    const providerRaw = ctx.match[1];
    const provider = providerRaw === "yoo" ? PaymentProvider.YOOKASSA : PaymentProvider.CRYPTOBOT;
    const planDays = Number(ctx.match[2]) as 30 | 90 | 180;
    const deviceLimit = Number(ctx.match[3]);

    const lockKey = `buy:do:${ctx.from.id}:${providerRaw}:${planDays}:${deviceLimit}:${ctx.callbackQuery?.message?.message_id ?? ""}`;
    if (!lock(lockKey)) return;
    try {
      const created = await deps.payments.createSubscriptionCheckout({
        telegramId: String(ctx.from.id),
        provider,
        planDays,
        deviceLimit,
      });

      const text = ["Готово. Остался один шаг.", "", "Открой ссылку и оплати 👇", created.payUrl, "", "После оплаты я всё обновлю сам."]
        .join("\n");

      await replyOrEdit(ctx, text, { reply_markup: backToCabinetKeyboard(deps) });
    } catch (e: any) {
      const text = `Не удалось создать оплату: ${e?.message ?? String(e)}`;
      await replyOrEdit(ctx, text, { reply_markup: backToCabinetKeyboard(deps) });
    } finally {
      unlock(lockKey);
    }
  });

  bot.callbackQuery("dev:pay", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDevicePayMethod(ctx);
  });

  bot.callbackQuery(/^dev:do:(yoo|cb)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from?.id) return;

    const providerRaw = ctx.match[1];
    const provider = providerRaw === "yoo" ? PaymentProvider.YOOKASSA : PaymentProvider.CRYPTOBOT;

    const lockKey = `dev:do:${ctx.from.id}:${providerRaw}:${ctx.callbackQuery?.message?.message_id ?? ""}`;
    if (!lock(lockKey)) return;
    try {
      const created = await deps.payments.createDeviceSlotCheckout({
        telegramId: String(ctx.from.id),
        provider,
      });

      const text = ["📱 Добавляем устройство", "", "Открой ссылку и оплати 👇", created.payUrl, "", "После оплаты лимит вырастет автоматически."]
        .join("\n");

      await replyOrEdit(ctx, text, { reply_markup: backToCabinetKeyboard(deps) });
    } catch (e: any) {
      const text = `Не удалось создать оплату: ${e?.message ?? String(e)}`;
      await replyOrEdit(ctx, text, { reply_markup: backToCabinetKeyboard(deps) });
    } finally {
      unlock(lockKey);
    }
  });

  bot.callbackQuery(/^guide:(android|ios|desktop)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGuide(ctx, ctx.match[1] as any);
  });

  bot.callbackQuery("sub:copy", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Скопируй ссылку в сообщении", show_alert: false });
  });

  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Bot error", err);
  });

  return bot;
}
