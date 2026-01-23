import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { PrismaClient } from "@prisma/client";
import path from "node:path";
import { MAIN_KEYBOARD } from "./keyboard";
import type { OnboardingService } from "../modules/onboarding/onboardingService";
import type { SubscriptionService } from "../modules/subscription/subscriptionService";
import type { PaymentService } from "../modules/payments/paymentService";
import { PaymentProvider } from "../db/values";
import { MAX_DEVICE_LIMIT, MIN_DEVICE_LIMIT } from "../domain/deviceLimits";
import { formatRuDayMonth } from "../domain/humanDate";
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

function supportButton(deps: BotDeps, label = "🆘 Поддержка"): InlineKeyboardButton {
  const sup = support(deps);
  if (sup.url) return { text: label, url: sup.url };
  return { text: label, callback_data: "nav:support" };
}

function backToCabinetKeyboard(deps: BotDeps): InlineKeyboard {
  return new InlineKeyboard().text("🏠 Главное меню", "nav:cabinet").row().add(supportButton(deps));
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
  const startPhotoPath = path.join(process.cwd(), "imag", "lis.png");
  let startPhotoFileId: string | undefined;
  type CheckoutFlow = "buy" | "ext";

  const sendStartScreen = async (ctx: any, caption: string): Promise<void> => {
    const opts = { caption, reply_markup: MAIN_KEYBOARD, link_preview_options: { is_disabled: true } };
    try {
      if (startPhotoFileId) {
        await ctx.replyWithPhoto(startPhotoFileId, opts);
        return;
      }
      const sent: any = await ctx.replyWithPhoto(new InputFile(startPhotoPath), opts);
      const fileId = sent?.photo?.[sent.photo.length - 1]?.file_id;
      if (fileId) startPhotoFileId = fileId;
    } catch {
      await ctx.reply(caption, { reply_markup: MAIN_KEYBOARD, link_preview_options: { is_disabled: true } });
    }
  };

  const buildStartCaption = (lines: string[] = []): string =>
    [
      "🦊 ЛисVPN — спокойный интернет без заморочек",
      "",
      "Эстония 🇪🇪 • стабильно • просто",
      "Подключил — и пользуешься",
      "",
      ...lines,
      "Жми «🚀 Подключить VPN» — дальше я всё сделаю.",
    ]
      .filter(Boolean)
      .join("\n");

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

    const kb = new InlineKeyboard().url("🆘 Открыть чат", url).row().text("🏠 Главное меню", "nav:cabinet");
    await replyOrEdit(ctx, text, { reply_markup: kb });
  };

  const requireUser = async (ctx: any): Promise<{ telegramId: string; user: any } | null> => {
    if (!ctx.from?.id) return null;
    const telegramId = String(ctx.from.id);
    const user = await deps.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      await replyOrEdit(ctx, "Нажми /start — и я запущу тебе ЛисVPN 🦊", { reply_markup: MAIN_KEYBOARD });
      return null;
    }
    return { telegramId, user };
  };

  const showCabinet = async (ctx: any): Promise<void> => {
    const required = await requireUser(ctx);
    if (!required) return;

    const { user } = required;

    let statusLine = "";
    try {
      const state = await deps.subscriptions.syncFromXui(user);
      const active = !!state.expiresAt && state.expiresAt.getTime() > Date.now() && state.enabled;
      if (active && state.expiresAt) statusLine = `✅ VPN работает до ${formatRuDayMonth(state.expiresAt)}`;
    } catch {
      // ignore
    }

    await sendStartScreen(ctx, buildStartCaption(statusLine ? [statusLine] : []));
  };

  const showMySubscription = async (ctx: any): Promise<void> => {
    const required = await requireUser(ctx);
    if (!required) return;

    const { user } = required;
    const state = await deps.subscriptions.syncFromXui(user);
    const sub = state.subscription;

    const active = !!state.expiresAt && state.expiresAt.getTime() > Date.now() && state.enabled;
    const expires = active && state.expiresAt ? formatRuDayMonth(state.expiresAt) : "";

    const text = [
      "💳 <b>Подписка</b>",
      "",
      active ? `✅ VPN работает до <b>${escapeHtml(expires)}</b>` : "🙈 Сейчас не активна",
      `📱 Устройства: <b>${escapeHtml(formatDevices(sub.deviceLimit))}</b>`,
    ]
      .filter(Boolean)
      .join("\n");

    const subUrl = deps.subscriptions.subscriptionUrl(deps.publicPanelBaseUrl, sub.xuiSubscriptionId);
    const kb = new InlineKeyboard().url("🚀 Подключить VPN", subUrl).row();
    if (active) kb.text("🔄 Продлить подписку", "ext:open").row();
    kb.text("📄 Инструкция", "nav:guide")
      .row()
      .text("🏠 Главное меню", "nav:cabinet")
      .row()
      .add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showDevices = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quoted: any;
    try {
      quoted = await deps.payments.quoteDeviceSlot({ telegramId });
    } catch {
      await replyOrEdit(ctx, "Нажми /start — и я запущу тебе ЛисVPN 🦊", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    const textLines = [
      "📱 <b>Устройства</b>",
      "",
      `Сейчас можно подключить: <b>${escapeHtml(formatDevices(quoted.currentDeviceLimit))}</b>`,
    ];

    const kb = new InlineKeyboard();

    if (quoted.canAdd) {
      textLines.push(`Добавить ещё одно устройство — <b>${escapeHtml(formatRubMinor(quoted.priceRubMinor))}</b>`);
      kb.text(`➕ Добавить за ${formatRubMinor(quoted.priceRubMinor)}`, "dev:pay").row();
    } else {
      textLines.push(`🚫 Сейчас максимум — ${MAX_DEVICE_LIMIT}.`);
    }

    kb.text("🏠 Главное меню", "nav:cabinet").row().add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, textLines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
  };

  const showDevicePayMethod = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quoted: any;
    try {
      quoted = await deps.payments.quoteDeviceSlot({ telegramId });
    } catch {
      await replyOrEdit(ctx, "Нажми /start — и я запущу тебе ЛисVPN 🦊", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    if (!quoted.canAdd) {
      await replyOrEdit(ctx, `🚫 Уже максимум — ${MAX_DEVICE_LIMIT}.`, { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const text = ["Выбери, как оплачиваем 💰", "", `+1 устройство — <b>${escapeHtml(formatRubMinor(quoted.priceRubMinor))}</b>`].join("\n");

    const kb = new InlineKeyboard()
      .text("₽ Рубли", "dev:do:yoo")
      .text("$ Крипта", "dev:do:cb")
      .row()
      .text("🔙 Назад", "nav:devices")
      .row()
      .text("🏠 Главное меню", "nav:cabinet")
      .row()
      .add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showBuyConfig = async (ctx: any, flow: CheckoutFlow, planDays: 30 | 90 | 180, deviceLimit: number): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quote: any;
    try {
      quote = await deps.payments.quoteSubscription({ telegramId, planDays, deviceLimit });
    } catch (e: any) {
      await replyOrEdit(ctx, "Не получилось посчитать цену. Попробуй ещё раз или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const chosenDevices = quote.selectedDeviceLimit;
    const total = formatRubMinor(quote.totalRubMinor);

    const title = flow === "ext" ? "🔄 Продлеваем подписку" : "🦊 Оформляем подписку";
    const payLabel = flow === "ext" ? `Продлить за ${total}` : `Оплатить ${total}`;

    const text = [
      title,
      "",
      "Сколько устройств подключаем?",
      `Выбрано: <b>${escapeHtml(formatDevices(chosenDevices))}</b>`,
      `Срок: <b>${planDays} дней</b>`,
      "",
      `${escapeHtml(formatDevices(chosenDevices))} — ${escapeHtml(total)}`,
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("➖", `${flow}:dev:dec:${planDays}:${chosenDevices}`)
      .text(`${chosenDevices}`, `${flow}:dev:noop:${planDays}:${chosenDevices}`)
      .text("➕", `${flow}:dev:inc:${planDays}:${chosenDevices}`)
      .row();

    for (let i = MIN_DEVICE_LIMIT; i <= MAX_DEVICE_LIMIT; i++) {
      kb.text(`${i}`, `${flow}:cfg:${planDays}:${i}`);
      if (i % 6 === 0) kb.row();
    }

    kb.row()
      .text("30 дней", `${flow}:cfg:30:${chosenDevices}`)
      .text("90 дней", `${flow}:cfg:90:${chosenDevices}`)
      .text("180 дней", `${flow}:cfg:180:${chosenDevices}`);

    kb.row().text(payLabel, `${flow}:pay:${planDays}:${chosenDevices}`);
    kb.row().text("🏠 Главное меню", "nav:cabinet");
    kb.row().add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showBuyMethod = async (ctx: any, flow: CheckoutFlow, planDays: 30 | 90 | 180, deviceLimit: number): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quote: any;
    try {
      quote = await deps.payments.quoteSubscription({ telegramId, planDays, deviceLimit });
    } catch (e: any) {
      await replyOrEdit(ctx, "Не получилось посчитать цену. Попробуй ещё раз или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const total = formatRubMinor(quote.totalRubMinor);

    const text = ["Выбери, как оплачиваем 💰", "", `Сумма: <b>${escapeHtml(total)}</b>`, `Срок: <b>${planDays} дней</b>`, `Устройства: <b>${escapeHtml(formatDevices(quote.selectedDeviceLimit))}</b>`].join("\n");

    const kb = new InlineKeyboard()
      .text("₽ Рубли", `${flow}:do:yoo:${planDays}:${quote.selectedDeviceLimit}`)
      .text("$ Крипта", `${flow}:do:cb:${planDays}:${quote.selectedDeviceLimit}`)
      .row()
      .text("🔙 Назад", `${flow}:cfg:${planDays}:${quote.selectedDeviceLimit}`)
      .row()
      .text("🏠 Главное меню", "nav:cabinet")
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
      .text("🏠 Главное меню", "nav:cabinet")
      .row()
      .add(supportButton(deps));

    await replyOrEdit(ctx, "📄 Инструкция. Выбери устройство", { reply_markup: kb });
  };

  const showGuide = async (ctx: any, platform: "android" | "ios" | "desktop"): Promise<void> => {
    const title = platform === "android" ? "Android" : platform === "ios" ? "iPhone" : "Windows и Mac";

    const steps =
      platform === "android"
        ? [
            "1. В боте нажми «🚀 Подключить VPN»",
            "2. Откроется подписка в панели",
            "3. Выбери приложение (например, Hiddify) и открой подписку",
            "4. Включи VPN",
          ]
        : platform === "ios"
          ? [
              "1. В боте нажми «🚀 Подключить VPN»",
              "2. Откроется подписка в панели",
              "3. Выбери приложение (например, Hiddify) и открой подписку",
              "4. Включи VPN",
            ]
          : [
              "1. В боте нажми «🚀 Подключить VPN»",
              "2. Откроется подписка в панели",
              "3. Выбери приложение и добавь подписку",
              "4. Включи VPN",
            ];

    const text = [`📄 <b>Инструкция. ${escapeHtml(title)}</b>`, "", ...steps, "", "Если что-то не так, жми Поддержка."].join("\n");

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

    const now = Date.now();
    const active = !!result.expiresAt && result.expiresAt.getTime() > now && result.enabled;

    const extraLines: string[] = [];
    if (result.isTrialGrantedNow) extraLines.push("🎁 Лови подарок: 7 дней бесплатно.");
    if (active && result.expiresAt) extraLines.push(`✅ VPN работает до ${formatRuDayMonth(result.expiresAt)}`);

    await sendStartScreen(ctx, buildStartCaption(extraLines));
  });

  bot.hears("🚀 Подключить VPN", async (ctx) => {
    const required = await requireUser(ctx);
    if (!required) return;

    const state = await deps.subscriptions.syncFromXui(required.user);
    const active = !!state.expiresAt && state.expiresAt.getTime() > Date.now() && state.enabled;
    if (active) {
      await showMySubscription(ctx);
      return;
    }

    await showBuyConfig(ctx, 30, MIN_DEVICE_LIMIT);
  });
  bot.hears("📱 Устройства", showDevices);
  bot.hears("💳 Подписка", showMySubscription);
  bot.hears("🆘 Поддержка", showSupport);

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

      const text = ["Почти всё 👌", "", "Открой ссылку и оплати 👇", created.payUrl, "", "После оплаты я сам всё включу."]
        .join("\n");

      await replyOrEdit(ctx, text, { reply_markup: backToCabinetKeyboard(deps) });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("createSubscriptionCheckout failed", e);
      await replyOrEdit(ctx, "Не получилось создать оплату. Попробуй ещё раз или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
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

      const text = ["📱 Добавляем устройство", "", "Открой ссылку и оплати 👇", created.payUrl, "", "После оплаты устройств станет больше автоматически."]
        .join("\n");

      await replyOrEdit(ctx, text, { reply_markup: backToCabinetKeyboard(deps) });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("createDeviceSlotCheckout failed", e);
      await replyOrEdit(ctx, "Не получилось создать оплату. Попробуй ещё раз или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
    } finally {
      unlock(lockKey);
    }
  });

  bot.callbackQuery(/^guide:(android|ios|desktop)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGuide(ctx, ctx.match[1] as any);
  });

  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Bot error", err);
  });

  return bot;
}
