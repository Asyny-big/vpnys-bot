import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { PrismaClient } from "@prisma/client";
import path from "node:path";
import { URL } from "node:url";
import { MAIN_KEYBOARD } from "./keyboard";
import type { OnboardingService } from "../modules/onboarding/onboardingService";
import type { SubscriptionService } from "../modules/subscription/subscriptionService";
import type { PaymentService } from "../modules/payments/paymentService";
import { PaymentProvider, PaymentStatus } from "../db/values";
import { MAX_DEVICE_LIMIT, MIN_DEVICE_LIMIT } from "../domain/deviceLimits";
import { formatRuDateTime, formatRuDayMonth } from "../domain/humanDate";
import { isOfferAccepted, shortPublicOfferText } from "../domain/offer";
import { escapeHtml, formatDevices, formatRub } from "./ui";
import type { PromoService } from "../modules/promo/promoService";
import { REFERRAL_REWARD_DAYS } from "../modules/referral/referralService";
import type { ReferralService } from "../modules/referral/referralService";
import type { BanService } from "../modules/ban/banService";
import type { AdminUserDeletionService } from "../modules/admin/userDeletionService";
import type { AdminUserBanService } from "../modules/admin/userBanService";
import type { DeviceService } from "../modules/devices/deviceService";
import { registerBroadcast } from "./broadcast";

export type BotDeps = Readonly<{
  botToken: string;
  telegramBotUrl: string;
  botImageFileId?: string;
  prisma: PrismaClient;
  onboarding: OnboardingService;
  subscriptions: SubscriptionService;
  payments: PaymentService;
  promos: PromoService;
  referrals: ReferralService;
  devices: DeviceService;
  adminDeletion: AdminUserDeletionService;
  adminBans: AdminUserBanService;
  bans: BanService;
  backendPublicUrl: string;
  offerVersion: string;
  adminUsername?: string;
  adminUserIds: ReadonlySet<string>;
}>;

type ReplyOpts = any;

export enum CheckoutFlow {
  BUY = "buy",
  EXTEND = "ext",
  PROMO = "promo",
}

function resolveAdminId(deps: BotDeps): number | null {
  for (const id of deps.adminUserIds) {
    const parsed = Number.parseInt(String(id), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function resolveSupportUsername(deps: BotDeps): string {
  return (deps.adminUsername?.replace(/^@/, "") ?? "").trim();
}

function resolveSupportUrl(deps: BotDeps): string | null {
  const username = resolveSupportUsername(deps);
  if (username.length) return `https://t.me/${encodeURIComponent(username)}`;

  const adminId = resolveAdminId(deps);
  if (adminId !== null) return `tg://user?id=${adminId}`;

  return null;
}

function supportButton(deps: BotDeps, label = "🆘 Поддержка"): InlineKeyboardButton {
  const url = resolveSupportUrl(deps);
  if (url) return { text: label, url };
  return { text: label, callback_data: "nav:support" };
}

function backToCabinetKeyboard(deps: BotDeps): InlineKeyboard {
  return new InlineKeyboard().text("🏠 Личный кабинет", "nav:cabinet").row().add(supportButton(deps));
}

async function replyOrEdit(ctx: any, text: string, opts: ReplyOpts = {}): Promise<void> {
  try {
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, { ...opts, link_preview_options: { is_disabled: true } });
        return;
      } catch {
        const replyMarkup = opts.reply_markup;
        const canEditWithMarkup = replyMarkup === undefined || replyMarkup instanceof InlineKeyboard;
        if (canEditWithMarkup) {
          try {
            await ctx.editMessageCaption(text, { parse_mode: opts.parse_mode, reply_markup: replyMarkup });
            return;
          } catch {
            // fall through to reply
          }
        }
      }
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
    .text("📄 Инструкция", "nav:guide")
    .row()
    .add(supportButton(deps, "🆘 Написать в поддержку"));

  return kb;
}

export function buildBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.botToken);
  const inFlight = new Map<string, number>();
  const inflightTtlMs = 30_000;
  const startPhotoPath = path.join(process.cwd(), "imag", "lis.png");
  let startPhotoFileId: string | undefined;
  let botImageFileId = deps.botImageFileId?.trim() || undefined;
  const blockedText = "\u26D4 \u0412\u044B \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u044B \u0432 LisVPN";

  const isAdmin = (ctx: any): boolean => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return false;
    return deps.adminUserIds.has(String(telegramId));
  };

  registerBroadcast(bot, deps.prisma, isAdmin);

  const ensureNotBlocked = async (ctx: any, telegramId: string): Promise<boolean> => {
    try {
      const blocked = await deps.bans.isBlocked(telegramId);
      if (!blocked) return true;
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: blockedText, show_alert: true }).catch(() => { });
      }
      await replyOrEdit(ctx, blockedText, { reply_markup: MAIN_KEYBOARD });
      return false;
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("ban check failed", { telegramId, errorName: e?.name, errorMessage: e?.message });
      await replyOrEdit(ctx, "❌ Временная ошибка. Попробуй ещё раз.", { reply_markup: MAIN_KEYBOARD });
      return false;
    }
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId) return await next();
    const telegramId = String(fromId);
    if (!(await ensureNotBlocked(ctx, telegramId))) return;
    return await next();
  });

  const parseExpiresAt = (value: string): Date | null => {
    const trimmed = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  };

  const buildReferralLink = (telegramId: string): string => {
    // Format: https://t.me/<BOT_USERNAME>?start=ref_<INVITER_TELEGRAM_ID>
    const url = new URL(deps.telegramBotUrl);
    url.searchParams.set("start", `ref_${telegramId}`);
    return url.toString();
  };

  const MAX_TELEGRAM_CAPTION_LENGTH = 1024;
  const replyOrEditBranded = async (ctx: any, caption: string, opts: ReplyOpts = {}): Promise<void> => {
    if (!botImageFileId) {
      await replyOrEdit(ctx, caption, opts);
      return;
    }
    if (caption.length > MAX_TELEGRAM_CAPTION_LENGTH) {
      await replyOrEdit(ctx, caption, opts);
      return;
    }

    const replyMarkup = opts.reply_markup;
    const canEditWithMarkup = replyMarkup === undefined || replyMarkup instanceof InlineKeyboard;

    try {
      if (ctx.callbackQuery?.message && canEditWithMarkup) {
        // If the current message is already a photo: edit caption.
        await ctx.editMessageCaption(caption, { parse_mode: opts.parse_mode, reply_markup: replyMarkup });
        return;
      }
    } catch {
      // fall through (may be a text message -> needs editMessageMedia)
    }

    try {
      if (ctx.callbackQuery?.message && canEditWithMarkup) {
        // Convert text -> photo (or replace media) while keeping the same message thread.
        await ctx.editMessageMedia(
          { type: "photo", media: botImageFileId, caption, parse_mode: opts.parse_mode },
          { reply_markup: replyMarkup },
        );
        return;
      }
    } catch {
      // fall back to plain text
    }

    try {
      await ctx.replyWithPhoto(botImageFileId, { caption, parse_mode: opts.parse_mode, reply_markup: replyMarkup });
      return;
    } catch {
      await replyOrEdit(ctx, caption, opts);
    }
  };

  const sendStartScreen = async (ctx: any, caption: string): Promise<void> => {
    const opts = { caption, parse_mode: "HTML" as const, reply_markup: MAIN_KEYBOARD };
    try {
      if (botImageFileId) {
        await ctx.replyWithPhoto(botImageFileId, opts);
        return;
      }
      if (startPhotoFileId) {
        await ctx.replyWithPhoto(startPhotoFileId, opts);
        return;
      }
      const sent: any = await ctx.replyWithPhoto(new InputFile(startPhotoPath), opts);
      const fileId = sent?.photo?.[sent.photo.length - 1]?.file_id;
      if (fileId) {
        startPhotoFileId = fileId;
        botImageFileId = fileId;
      }
    } catch {
      await ctx.reply(caption, { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD, link_preview_options: { is_disabled: true } });
    }
  };

  const buildStartCaption = (lines: string[] = []): string =>
    [
      "🦊 <b>ЛисVPN</b> — быстрый и тихий интернет",
      "",
      "🇪🇪 Сервер в Эстонии",
      "⚡ Стабильно и просто",
      "🚀 Подключение за минуту",
      "",
      ...lines,
      lines.length ? "" : "",
      "👇 Открой <b>«🏠 Личный кабинет»</b> — дальше я всё сделаю.",
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
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
    const supportUrl = resolveSupportUrl(deps);
    const username = resolveSupportUsername(deps);

    if (!supportUrl && !username.length) {
      await replyOrEdit(ctx, "Поддержка пока не настроена. Но мы рядом.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const text = [
      "🆘 <b>Поддержка LisVPN</b>",
      "",
      "<blockquote>Если что-то не работает или есть вопрос — напиши нам.",
      "Мы ответим и поможем 🦊",
      "</blockquote>",
      "",
      ...(username.length ? [`📨 Контакт: <b>@${escapeHtml(username)}</b>`] : []),
    ].join("\n");

    const kb = new InlineKeyboard();
    if (supportUrl) kb.url("💬 Написать в поддержку", supportUrl).row();
    kb.text("🏠 Личный кабинет", "nav:cabinet");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
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

    const firstName = escapeHtml(String(ctx.from?.first_name ?? "Пользователь"));
    const username = ctx.from?.username ? `@${escapeHtml(String(ctx.from.username))}` : "";
    const telegramId = String(ctx.from?.id ?? "");

    let active = false;
    let expiresAtLabel = "";
    let deviceLimit = "";

    try {
      const state = await deps.subscriptions.syncFromXui(user);
      const effectiveExpiresAt =
        state.expiresAt && state.subscription.paidUntil
          ? (state.expiresAt.getTime() > state.subscription.paidUntil.getTime() ? state.expiresAt : state.subscription.paidUntil)
          : (state.expiresAt ?? state.subscription.paidUntil ?? undefined);
      active = !!effectiveExpiresAt && effectiveExpiresAt.getTime() > Date.now() && state.enabled;
      expiresAtLabel = active && effectiveExpiresAt ? formatRuDateTime(effectiveExpiresAt) : "";
      deviceLimit = formatDevices(state.subscription.deviceLimit);
    } catch {
      // Fallback to cached DB state if 3x-ui is temporarily unavailable.
      const sub = await deps.prisma.subscription.findUnique({ where: { userId: user.id } });
      if (sub) {
        const effectiveExpiresAt =
          sub.expiresAt && sub.paidUntil
            ? (sub.expiresAt.getTime() > sub.paidUntil.getTime() ? sub.expiresAt : sub.paidUntil)
            : (sub.expiresAt ?? sub.paidUntil ?? undefined);
        active = !!effectiveExpiresAt && effectiveExpiresAt.getTime() > Date.now() && sub.enabled;
        expiresAtLabel = active && effectiveExpiresAt ? formatRuDateTime(effectiveExpiresAt) : "";
        deviceLimit = formatDevices(sub.deviceLimit);
      }
    }

    const statusBlock = active && expiresAtLabel
      ? [
        "<blockquote>🟢 <b>VPN активен</b>",
        `📅 До: <b>${escapeHtml(expiresAtLabel)}</b>`,
        ...(deviceLimit ? [`📱 Устройства: <b>${escapeHtml(deviceLimit)}</b>`] : []),
        "</blockquote>",
      ]
      : [
        "<blockquote>⚪ <b>VPN не активен</b>",
        "✨ Подключи подписку — и поехали",
        "</blockquote>",
      ];

    const profileLines = [
      `• Имя: <b>${firstName}</b>`,
      ...(username ? [`• Username: <b>${username}</b>`] : []),
      `• Telegram ID: <code>${escapeHtml(telegramId)}</code>`,
    ];

    const text = [
      "🏠 <b>Личный кабинет</b>",
      "",
      "👤 <b>Профиль</b>",
      ...profileLines,
      "",
      "📊 <b>Статус</b>",
      ...statusBlock,
    ].join("\n");

    const kb = new InlineKeyboard();
    if (active) {
      kb.text("🔄 Продлить подписку", "ext:open").row();
      kb.text("🔐 Моя подписка", "nav:sub").row();
      kb.text("📱 Мои устройства", "devices:list").row();
    } else {
      kb.text("🚀 Подключить VPN", "nav:buy").row();
      kb.text("📱 Мои устройства", "devices:list").row();
    }

    kb.text("🎁 Промокод", "nav:promo").text("🔗 Рефералка", "nav:ref").row();
    kb.add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEditBranded(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showReferral = async (ctx: any): Promise<void> => {
    const required = await requireUser(ctx);
    if (!required) return;

    const referralLink = buildReferralLink(required.telegramId);
    const rows = await deps.referrals.listInvitedFriends({ inviterUserId: required.user.id, take: 50 });
    const invitedCount = rows.length;
    const rewardedCount = rows.filter((r) => r.rewardGiven).length;
    const pendingCount = invitedCount - rewardedCount;
    const bonusDays = rewardedCount * REFERRAL_REWARD_DAYS;

    const now = new Date();
    const maxToShow = 30;
    const shown = rows.slice(0, maxToShow);

    const invitedLines: string[] = [];
    for (let i = 0; i < shown.length; i++) {
      const row = shown[i];
      let invitedLabel = `ID ${row.invitedTelegramId}`;
      try {
        const chat: any = await ctx.api.getChat(Number(row.invitedTelegramId));
        invitedLabel = chat?.username ? `@${chat.username}` : chat?.first_name ?? invitedLabel;
      } catch {
        // ignore
      }
      const registeredAt = formatRuDayMonth(row.invitedCreatedAt, now);
      const rewardLabel = row.rewardGiven ? `+${REFERRAL_REWARD_DAYS} дней` : "ожидает";
      invitedLines.push(`${i + 1}) ${escapeHtml(invitedLabel)} — ${escapeHtml(registeredAt)} (${rewardLabel})`);
    }

    const listFooter = invitedCount > maxToShow ? `Показаны последние ${maxToShow} из ${invitedCount}.` : "";

    const friendsSection = invitedCount
      ? ["👥 <b>Последние друзья</b>", ...invitedLines, ...(listFooter ? [listFooter] : [])]
      : ["👥 <b>Последние друзья</b>", "<i>Пока пусто. Отправь ссылку другу — и он появится здесь.</i>"];

    const text = [
      "🔗 <b>Рефералка</b>",
      "",
      `<blockquote>🎁 <b>+${REFERRAL_REWARD_DAYS} дней</b> тебе и другу`,
      "За каждого нового друга — один раз.",
      "</blockquote>",
      "",
      "📎 <b>Твоя ссылка</b>",
      "<i>Нажми, чтобы скопировать:</i>",
      `<code>${escapeHtml(referralLink)}</code>`,
      "",
      "📊 <b>Статистика</b>",
      `• 👥 Приглашено: <b>${invitedCount}</b>`,
      `• 🎁 Начислено: <b>${bonusDays} дней</b>`,
      `• ⏳ Ожидает: <b>${pendingCount}</b>`,
      "",
      "ℹ️ <b>Как это работает</b>",
      "1. Отправь другу свою ссылку",
      "2. Друг запускает бота впервые по ней",
      "3. Обоим начисляем бонусные дни",
      "",
      "<i>Если друг уже пользовался ботом или сработает анти-абьюз — бонуса не будет.</i>",
      "",
      ...friendsSection,
    ].join("\n");

    await replyOrEditBranded(ctx, text, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
  };

  const showMySubscription = async (ctx: any): Promise<void> => {
    const required = await requireUser(ctx);
    if (!required) return;

    const { user } = required;
    const state = await deps.subscriptions.syncFromXui(user);
    const sub = state.subscription;

    const effectiveExpiresAt =
      state.expiresAt && sub.paidUntil
        ? (state.expiresAt.getTime() > sub.paidUntil.getTime() ? state.expiresAt : sub.paidUntil)
        : (state.expiresAt ?? sub.paidUntil ?? undefined);

    const active = !!effectiveExpiresAt && effectiveExpiresAt.getTime() > Date.now() && state.enabled;
    const expires = active && effectiveExpiresAt ? formatRuDateTime(effectiveExpiresAt) : "";

    const token = sub.xuiSubscriptionId;
    const connectUrl = deps.subscriptions.connectUrl(deps.backendPublicUrl, token);
    const subscriptionUrl = deps.subscriptions.subscriptionUrl(deps.backendPublicUrl, token);

    const kb = new InlineKeyboard();

    let text: string;
    if (active) {
      text = [
        "🔐 <b>Моя подписка</b>",
        "",
        "<blockquote>🟢 <b>VPN активен</b>",
        `📅 До: <b>${escapeHtml(expires)}</b>`,
        `📱 Устройства: <b>${escapeHtml(formatDevices(sub.deviceLimit))}</b>`,
        "</blockquote>",
        "",
        "🔗 <b>Ссылка подписки</b>",
        "<i>Нажми на ссылку — она скопируется:</i>",
        `<code>${escapeHtml(subscriptionUrl)}</code>`,
        "",
        "💡 Вставь её в приложение (Happ, V2rayNG, Hiddify и т.п.) и включи VPN.",
        "",
        "<i>🦊 Проще всего — через страницу подключения кнопкой ниже.</i>",
      ].join("\n");

      kb.url("🚀 Страница подключения", connectUrl).row();
      kb.text("🔄 Продлить подписку", "ext:open").row();
      kb.text("📄 Инструкция", "nav:guide").row();
    } else {
      text = [
        "🔐 <b>Моя подписка</b>",
        "",
        "<blockquote>⚪ <b>VPN не активен</b>",
        "Оформи подписку — и всё заработает за минуту.",
        "</blockquote>",
      ].join("\n");

      kb.text("💳 Оформить подписку", "nav:buy").row();
    }

    kb.text("🏠 Личный кабинет", "nav:cabinet").row();
    kb.add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEditBranded(ctx, text, { parse_mode: "HTML", reply_markup: kb });
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
      `<blockquote>🔢 Текущий лимит: <b>${escapeHtml(formatDevices(quoted.currentDeviceLimit))}</b></blockquote>`,
      "",
    ];

    const kb = new InlineKeyboard();

    if (quoted.canAdd) {
      textLines.push(`➕ Добавить слот — <b>${escapeHtml(formatRub(quoted.priceRub))}</b>`);
      kb.text(`➕ Добавить за ${formatRub(quoted.priceRub)}`, "dev:pay").row();
    } else {
      textLines.push(`🚫 Сейчас максимум — <b>${MAX_DEVICE_LIMIT}</b>.`);
    }

    kb.text("🏠 Личный кабинет", "nav:cabinet").row().add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, textLines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
  };

  const showDevicePayMethod = async (ctx: any): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    let quoted: any;
    try {
      quoted = await deps.payments.quoteDeviceSlot({ telegramId });
    } catch (e: any) {
      if (e?.message === "Subscription is not active") {
        await replyOrEdit(ctx, "Докупка устройства доступна только при активной подписке. Сначала оформи/продли подписку.", { reply_markup: backToCabinetKeyboard(deps) });
        return;
      }
      await replyOrEdit(ctx, "Нажми /start — и я запущу тебе ЛисVPN 🦊", { reply_markup: MAIN_KEYBOARD });
      return;
    }

    if (!quoted.canAdd) {
      await replyOrEdit(ctx, `🚫 Уже максимум — ${MAX_DEVICE_LIMIT}.`, { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const text = [
      "💰 <b>Как оплачиваем?</b>",
      "",
      `<blockquote>➕ +1 устройство — <b>${escapeHtml(formatRub(quoted.priceRub))}</b></blockquote>`,
    ].join("\n");

    const hasYoo = deps.payments.isYooKassaEnabled();
    const hasCb = deps.payments.isCryptoBotEnabled();
    if (!hasYoo && !hasCb) {
      await replyOrEdit(ctx, "Оплата сейчас недоступна. Попробуй позже или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const kb = new InlineKeyboard();
    if (hasYoo) kb.text("₽ Рубли (ЮKassa)", "dev:do:yoo");
    if (hasCb) kb.text("$ Крипта", "dev:do:cb");
    kb.row()
      .text("🔙 Назад", "nav:devices")
      .row()
      .text("🏠 Личный кабинет", "nav:cabinet")
      .row()
      .add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showBuyConfig = async (ctx: any, flow: CheckoutFlow, planDays: 30 | 90 | 180, deviceLimit: number): Promise<void> => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    const hasYoo = deps.payments.isYooKassaEnabled();
    const hasCb = deps.payments.isCryptoBotEnabled();
    if (!hasYoo && !hasCb) {
      await replyOrEdit(ctx, "Оплата сейчас недоступна. Попробуй позже или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    let quote: any;
    try {
      quote = await deps.payments.quoteSubscription({ telegramId, planDays, deviceLimit });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("quoteSubscription failed", { telegramId, flow, planDays, deviceLimit, error: e });
      await replyOrEdit(ctx, "Не получилось посчитать цену. Попробуй ещё раз или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const chosenDevices = quote.selectedDeviceLimit;
    const total = formatRub(quote.totalRub);

    const title = flow === CheckoutFlow.EXTEND ? "🔄 <b>Продление подписки</b>" : "🦊 <b>Оформление подписки</b>";
    const payLabel = flow === CheckoutFlow.EXTEND ? `🔄 Продлить · ${total}` : `💳 Оплатить · ${total}`;

    const text = [
      title,
      "",
      "<blockquote>📅 Срок: <b>" + planDays + " дней</b>",
      `📱 Устройства: <b>${escapeHtml(formatDevices(chosenDevices))}</b>`,
      `💰 Итого: <b>${escapeHtml(total)}</b>`,
      "</blockquote>",
      "",
      "<i>Настрой параметры ниже 👇</i>",
    ].join("\n");

    const kb = new InlineKeyboard();

    kb.text("📱 Устройства", `${flow}:dev:noop:${planDays}:${chosenDevices}`).row();
    kb.text("➖", `${flow}:dev:dec:${planDays}:${chosenDevices}`)
      .text(`${chosenDevices}`, `${flow}:dev:noop:${planDays}:${chosenDevices}`)
      .text("➕", `${flow}:dev:inc:${planDays}:${chosenDevices}`)
      .row();

    for (let i = MIN_DEVICE_LIMIT; i <= MAX_DEVICE_LIMIT; i++) {
      const label = i === chosenDevices ? `• ${i} •` : `${i}`;
      kb.text(label, `${flow}:cfg:${planDays}:${i}`);
      if (i % 6 === 0) kb.row();
    }

    kb.row().text("📅 Срок", `${flow}:cfg:${planDays}:${chosenDevices}`).row();
    kb.text(
      planDays === 30 ? "• 30 дней •" : "30 дней",
      `${flow}:cfg:30:${chosenDevices}`,
    )
      .text(
        planDays === 90 ? "• 90 дней •" : "90 дней",
        `${flow}:cfg:90:${chosenDevices}`,
      )
      .text(
        planDays === 180 ? "• 180 дней •" : "180 дней",
        `${flow}:cfg:180:${chosenDevices}`,
      );

    kb.row().text(payLabel, `${flow}:pay:${planDays}:${chosenDevices}`);
    kb.row().text("🏠 Личный кабинет", "nav:cabinet");
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
      // eslint-disable-next-line no-console
      console.error("quoteSubscription failed", { telegramId, flow, planDays, deviceLimit, error: e });
      await replyOrEdit(ctx, "Не получилось посчитать цену. Попробуй ещё раз или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const total = formatRub(quote.totalRub);

    const text = [
      "💰 <b>Как оплачиваем?</b>",
      "",
      `<blockquote>💵 Сумма: <b>${escapeHtml(total)}</b>`,
      `📅 Срок: <b>${planDays} дней</b>`,
      `📱 Устройства: <b>${escapeHtml(formatDevices(quote.selectedDeviceLimit))}</b>`,
      "</blockquote>",
    ].join("\n");

    const hasYoo = deps.payments.isYooKassaEnabled();
    const hasCb = deps.payments.isCryptoBotEnabled();
    if (!hasYoo && !hasCb) {
      await replyOrEdit(ctx, "Оплата сейчас недоступна. Попробуй позже или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const kb = new InlineKeyboard();
    if (hasYoo) kb.text("₽ Рубли (ЮKassa)", `${flow}:do:yoo:${planDays}:${quote.selectedDeviceLimit}`);
    if (hasCb) kb.text("$ Крипта", `${flow}:do:cb:${planDays}:${quote.selectedDeviceLimit}`);
    kb.row()
      .text("🔙 Назад", `${flow}:cfg:${planDays}:${quote.selectedDeviceLimit}`)
      .row()
      .text("🏠 Личный кабинет", "nav:cabinet")
      .row()
      .add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const buildCheckoutMessage = (payUrl: string): { text: string; reply_markup: InlineKeyboard; parse_mode: "HTML" } => {
    const text = [
      "💳 <b>Счёт готов</b>",
      "",
      "Нажми кнопку ниже или скопируй ссылку:",
      `<code>${escapeHtml(payUrl)}</code>`,
      "",
      "<i>🦊 После оплаты я всё включу автоматически.</i>",
    ].join("\n");

    const kb = new InlineKeyboard()
      .url("💳 Оплатить", payUrl).row()
      .text("🏠 Личный кабинет", "nav:cabinet").row()
      .add(supportButton(deps, "🆘 Поддержка"));

    return { text, reply_markup: kb, parse_mode: "HTML" };
  };

  const startSubscriptionCheckout = async (ctx: any, flow: CheckoutFlow, providerRaw: "yoo" | "cb", planDays: 30 | 90 | 180, deviceLimit: number): Promise<void> => {
    if (!ctx.from?.id) return;

    const provider = providerRaw === "yoo" ? PaymentProvider.YOOKASSA : PaymentProvider.CRYPTOBOT;

    const lockKey = `${flow}:do:${ctx.from.id}:${providerRaw}:${planDays}:${deviceLimit}:${ctx.callbackQuery?.message?.message_id ?? ""}`;
    if (!lock(lockKey)) return;
    try {
      const created = await deps.payments.createSubscriptionCheckout({
        telegramId: String(ctx.from.id),
        provider,
        planDays,
        deviceLimit,
      });

      const msg = buildCheckoutMessage(created.payUrl);
      await replyOrEdit(ctx, msg.text, { parse_mode: msg.parse_mode, reply_markup: msg.reply_markup });
    } catch (e: any) {
      if (e?.name === "OfferNotAcceptedError") {
        await showOfferOnceAndRecord(ctx, String(ctx.from.id));
        const created = await deps.payments.createSubscriptionCheckout({
          telegramId: String(ctx.from.id),
          provider,
          planDays,
          deviceLimit,
        });
        const msg = buildCheckoutMessage(created.payUrl);
        await replyOrEdit(ctx, msg.text, { parse_mode: msg.parse_mode, reply_markup: msg.reply_markup });
        return;
      }
      // eslint-disable-next-line no-console
      console.error("createSubscriptionCheckout failed", e);
      await replyOrEdit(ctx, "Не получилось создать оплату. Попробуй ещё раз или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
    } finally {
      unlock(lockKey);
    }
  };

  const showGuide = async (ctx: any): Promise<void> => {
    const text = [
      "📄 <b>Инструкция</b>",
      "",
      "🚀 <b>Подключение за 3 шага</b>",
      "<blockquote>1️⃣ В Кабинете открой <b>«Моя подписка»</b>",
      "2️⃣ Нажми <b>«🚀 Страница подключения»</b>",
      "3️⃣ Выбери <b>Happ</b>, добавь подписку и включи VPN",
      "</blockquote>",
      "",
      "🦊 <b>Как выбрать сервер</b>",
      "<blockquote>🟢 Зелёный — работает, выбирай его",
      "🔴 Красный — не работает, пропускай",
      "🔢 Цифры — скорость отклика (меньше = лучше)",
      "«н/д» — сервер не отвечает",
      "⚡ Не грузит? Смени на другой зелёный",
      "</blockquote>",
      "<i>🦊 Зелёный — друг. Красный — не сегодня.</i>",
      "",
      "📶 <b>«Белый список» оператора</b>",
      "Иногда мобильный оператор пропускает только отдельные сайты.",
      "В таких сетях <b>подписка может не добавляться</b> — это ограничение сети, не VPN.",
      "",
      "<i>💡 Добавляй подписку по Wi-Fi, а на мобильной сети — просто переключи сервер.</i>",
      "",
      "🔄 <b>Когда обновлять подписку</b>",
      "После переустановки приложения, на новом устройстве или если пропали серверы.",
      "Работает — <b>обновлять не нужно</b>.",
    ].join("\n");

    const kb = new InlineKeyboard().text("🏠 Личный кабинет", "nav:cabinet").row().add(supportButton(deps, "🆘 Поддержка"));
    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const showAbout = async (ctx: any): Promise<void> => {
    const text = [
      "🦊 <b>ЛисVPN</b>",
      "",
      "<blockquote>Интернет без нервов.",
      "Включил — и поехали.",
      "</blockquote>",
      "",
      "<i>Если что-то глючит — мы рядом.</i>",
    ].join("\n");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
  };

  const showDevicesMenu = async (ctx: any, userId: string): Promise<void> => {
    const [devices, limits] = await Promise.all([
      deps.devices.listDevices(userId),
      deps.devices.getDeviceLimits(userId),
    ]);

    const headerLines: string[] = ["📱 <b>Мои устройства</b>", ""];

    const slotsBadge = limits.availableSlots > 0
      ? `✅ Свободно слотов: <b>${limits.availableSlots}</b>`
      : "⚠️ <b>Лимит достигнут</b>";

    headerLines.push(
      `<blockquote>📊 Занято: <b>${limits.currentDevices} / ${limits.totalLimit}</b>`,
      slotsBadge,
      "</blockquote>",
      "",
    );

    if (devices.length === 0) {
      headerLines.push(
        "<i>Пока ни одного устройства не подключено.</i>",
        "",
        "💡 Открой ссылку подписки на любом устройстве — оно появится здесь автоматически (если есть свободный слот).",
      );
    } else {
      const now = new Date();
      const deviceBlockLines: string[] = [];
      for (const device of devices) {
        const lastSeen = new Date(device.lastSeenAt);
        const diffMs = now.getTime() - lastSeen.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        let timeAgo = "";
        if (diffDays === 0) timeAgo = "сегодня";
        else if (diffDays === 1) timeAgo = "вчера";
        else if (diffDays < 7) timeAgo = `${diffDays} дн. назад`;
        else timeAgo = formatRuDayMonth(lastSeen, now);

        deviceBlockLines.push(`📱 <b>${escapeHtml(device.deviceName)}</b>`);
        deviceBlockLines.push(`   <i>был в сети ${escapeHtml(timeAgo)}</i>`);
      }
      headerLines.push("<b>Подключённые устройства</b>", ...deviceBlockLines);
    }

    const text = headerLines.join("\n");

    const keyboard = new InlineKeyboard();

    for (const device of devices) {
      const label = device.deviceName.length > 22 ? `${device.deviceName.slice(0, 22)}…` : device.deviceName;
      keyboard.text(`❌ ${label}`, `devices:remove:${device.id}`).row();
    }

    if (limits.availableSlots === 0 && devices.length > 0) {
      keyboard.text("🛒 Купить доп. слот", "devices:buy_slot").row();
    }

    keyboard.text("🏠 Личный кабинет", "nav:cabinet").row();
    keyboard.add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: keyboard });
  };

  const showBuyDeviceSlotMenu = async (ctx: any, telegramId: string): Promise<void> => {
    let quoted: any;
    try {
      quoted = await deps.payments.quoteDeviceSlot({ telegramId });
    } catch {
      await replyOrEdit(ctx, "Докупка устройства доступна только при активной подписке.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const text = [
      "🛒 <b>Дополнительный слот</b>",
      "",
      `<blockquote>💳 Цена: <b>${escapeHtml(formatRub(quoted.priceRub))}</b>`,
      `📅 За остаток подписки: <b>${quoted.monthsRemaining} × 30 дней</b>`,
      "</blockquote>",
      "",
      "После оплаты добавим ещё один слот — подключай новое устройство.",
      "",
      "<i>🦊 Слот работает, пока активна подписка.</i>",
    ].join("\n");

    const keyboard = new InlineKeyboard();
    keyboard.text("₽ ЮKassa", `device_slot:pay:yookassa`).text("$ Crypto", `device_slot:pay:cryptobot`).row();
    keyboard.text("🔙 К устройствам", "devices:list").row();
    keyboard.text("🏠 Личный кабинет", "nav:cabinet").row();
    keyboard.add(supportButton(deps, "🆘 Поддержка"));

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: keyboard });
  };

  const showOffer = async (ctx: any): Promise<void> => {
    await replyOrEdit(ctx, shortPublicOfferText(), { reply_markup: backToCabinetKeyboard(deps) });
  };

  const showOfferOnceAndRecord = async (ctx: any, telegramId: string): Promise<Date | null> => {
    const existing = await deps.prisma.user.findUnique({
      where: { telegramId },
      select: { id: true, offerAcceptedAt: true },
    });
    if (existing?.offerAcceptedAt) return null;

    try {
      await ctx.reply(shortPublicOfferText(), { link_preview_options: { is_disabled: true } });
    } catch {
      return null;
    }

    const now = new Date();
    if (!existing) return now;

    await deps.prisma.user.updateMany({
      where: { id: existing.id, offerAcceptedAt: null },
      data: { offerAcceptedAt: now, offerVersion: deps.offerVersion },
    });
    return now;
  };

  const promoSessions = new Map<string, number>();
  const PROMO_SESSION_TTL_MS = 5 * 60 * 1000;

  const isInPromoSession = (telegramId: string): boolean => {
    const startedAt = promoSessions.get(telegramId);
    if (!startedAt) return false;
    if (Date.now() - startedAt > PROMO_SESSION_TTL_MS) {
      promoSessions.delete(telegramId);
      return false;
    }
    return true;
  };

  const openPromoDialog = async (ctx: any): Promise<void> => {
    const required = await requireUser(ctx);
    if (!required) return;

    promoSessions.set(required.telegramId, Date.now());

    const text = [
      "🎁 <b>Промокод</b>",
      "",
      "<blockquote>Отправь промокод следующим сообщением.",
      "Напиши <b>отмена</b>, чтобы выйти.",
      "</blockquote>",
      "",
      "<i>🦊 У вас есть 5 минут.</i>",
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("❌ Отмена", "promo:cancel").row()
      .text("🏠 Личный кабинет", "nav:cabinet");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: kb });
  };

  const applyPromoCode = async (ctx: any, required: { telegramId: string; user: any }, codeRaw: string): Promise<void> => {
    let result = await deps.promos.applyPromo({ userId: required.user.id, code: codeRaw });
    if (result.status === "offer_required") {
      await showOfferOnceAndRecord(ctx, required.telegramId);
      result = await deps.promos.applyPromo({ userId: required.user.id, code: codeRaw });
      if (result.status === "offer_required") {
        await replyOrEdit(ctx, "📄 Перед применением промокода нужно принять условия оферты. Попробуй ещё раз чуть позже.", { reply_markup: backToCabinetKeyboard(deps) });
        return;
      }
    }
    if (result.status === "not_found") {
      await replyOrEdit(ctx, "❌ <b>Промокод не найден</b>\n<i>Проверь регистр и пробелы.</i>", { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
      return;
    }
    if (result.status === "blocked") {
      await replyOrEdit(ctx, blockedText, { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }
    if (result.status === "cooldown") {
      await replyOrEdit(ctx, "⏳ Промокод можно активировать раз в час. Попробуй позже.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }
    if (result.status === "already_used") {
      await replyOrEdit(ctx, `ℹ️ Этот промокод уже использован: <b>${escapeHtml(result.promo.code)}</b>`, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
      return;
    }
    if (result.status === "expired") {
      await replyOrEdit(ctx, `❌ Промокод просрочен: <b>${escapeHtml(result.promo.code)}</b>`, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
      return;
    }
    if (result.status === "exhausted") {
      await replyOrEdit(ctx, `❌ Лимит активаций исчерпан: <b>${escapeHtml(result.promo.code)}</b>`, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    // Применяем новую дату к expiresAt и синхронизируем с 3x-ui
    try {
      await deps.subscriptions.setExpiryAndEnable({
        user: required.user,
        expiresAt: result.paidUntil,
        enable: true,
      });
    } catch (e) {
      console.error("Failed to sync promo to 3x-ui:", e);
      await replyOrEdit(ctx, "⚠️ Промокод записан, но произошла ошибка синхронизации. Попробуй обновить Личный кабинет.", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    const text = [
      "✅ <b>Промокод применён!</b>",
      "",
      `<blockquote>🎁 Код: <b>${escapeHtml(result.promo.code)}</b>`,
      `📅 Бонус: <b>+${result.promo.bonusDays} дней</b>`,
      `⏳ Оплачено до: <b>${escapeHtml(formatRuDateTime(result.paidUntil))}</b>`,
      "</blockquote>",
    ].join("\n");

    await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) });
  };

  // Обработчик диалогового ввода промокода.
  // Регистрируем ПОСЛЕ registerBroadcast (broadcast вызывает next() для не-админов),
  // но ДО `bot.hears(...)` для reply-клавиатуры, чтобы не-керуемый текст попадал сюда.
  bot.on("message:text", async (ctx, next) => {
    const telegramId = ctx.from?.id ? String(ctx.from.id) : null;
    if (!telegramId) return next();
    if (!isInPromoSession(telegramId)) return next();

    const raw = (ctx.message?.text ?? "").trim();
    if (!raw.length) return next();

    // Пропускаем команды и кнопки reply-клавиатуры — пусть обрабатывают другие хендлеры.
    if (raw.startsWith("/") || raw === "🏠 Личный кабинет" || raw === "🆘 Поддержка" || raw === "📱 Мои устройства") {
      promoSessions.delete(telegramId);
      return next();
    }

    const lower = raw.toLowerCase();
    if (lower === "отмена" || lower === "cancel") {
      promoSessions.delete(telegramId);
      await ctx.reply("Отменено 🙌", { reply_markup: backToCabinetKeyboard(deps) });
      return;
    }

    // Простая валидация: одно «слово» без пробелов, разумной длины.
    // Точное соответствие коду проверит бекенд (applyPromo вернёт "not_found").
    const codeCandidate = raw.replace(/^\/promo\s+/i, "").trim();
    if (codeCandidate.length > 64 || /\s/.test(codeCandidate)) {
      await ctx.reply(
        "❌ Похоже, это не промокод.\n\nОтправь промокод <b>одним сообщением, без пробелов</b>, или напиши <b>отмена</b>.",
        { parse_mode: "HTML" },
      );
      return;
    }

    promoSessions.delete(telegramId);
    const required = await requireUser(ctx);
    if (!required) return;
    await applyPromoCode(ctx, required, codeCandidate);
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from?.id) return;
    const telegramId = String(ctx.from.id);

    const startParam = typeof (ctx as any).match === "string" ? String((ctx as any).match).trim() : "";
    const offerAcceptedAt = await showOfferOnceAndRecord(ctx, telegramId);
    let paymentSyncStatus: "not_found" | "not_configured" | PaymentStatus | undefined;
    if (startParam.startsWith("pay_")) {
      const paymentId = startParam.slice("pay_".length).trim();
      if (paymentId.length) {
        try {
          const synced = await deps.payments.syncReturnPayment({ telegramId, paymentId });
          paymentSyncStatus = synced.status;
        } catch {
          // ignore
        }
      }
    }

    let result: any;
    try {
      result = await deps.onboarding.handleStart({ telegramId, startParam, offerAcceptedAt });
    } catch (e: any) {
      if (e?.name === "UserBlockedError") {
        await replyOrEdit(ctx, blockedText, { reply_markup: MAIN_KEYBOARD });
        return;
      }
      throw e;
    }

    const now = Date.now();
    const active = !!result.expiresAt && result.expiresAt.getTime() > now && result.enabled;

    const extraLines: string[] = [];
    if (paymentSyncStatus === PaymentStatus.SUCCEEDED) extraLines.push("✅ <b>Оплата подтверждена</b>");
    if (paymentSyncStatus === PaymentStatus.CANCELED) extraLines.push("❌ Платёж отменён.");
    if (paymentSyncStatus === PaymentStatus.PENDING) extraLines.push("⏳ Оплата обрабатывается. Если ты оплатил — подожди пару минут.");
    if (paymentSyncStatus === "not_configured") extraLines.push("ℹ️ Проверка оплаты недоступна. Я включу VPN, как только получу уведомление.");
    if (result.isTrialGrantedNow) extraLines.push("🎁 <b>Лови подарок:</b> 7 дней бесплатно ✨");
    if (result.referralReward) {
      try {
        const inviterChat: any = await ctx.api.getChat(Number(result.referralReward.inviterTelegramId));
        const inviterLabel = inviterChat?.username ? `@${inviterChat.username}` : inviterChat?.first_name ?? `ID ${result.referralReward.inviterTelegramId}`;
        extraLines.push(`🎉 Тебя пригласил <b>${escapeHtml(String(inviterLabel))}</b> — тебе начислено <b>+${REFERRAL_REWARD_DAYS} дней</b>!`);

        const invitedLabel = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? `ID ${telegramId}`;
        await ctx.api.sendMessage(
          Number(result.referralReward.inviterTelegramId),
          `🎉 У тебя новый друг: <b>${escapeHtml(String(invitedLabel))}</b>\nТебе начислено <b>+${REFERRAL_REWARD_DAYS} дней</b>!`,
          { parse_mode: "HTML" },
        ).catch(() => { });
      } catch {
        // Best-effort: registration and reward are already done in backend.
      }
    }
    if (active && result.expiresAt) extraLines.push(`✅ VPN работает до <b>${escapeHtml(formatRuDateTime(result.expiresAt))}</b>`);

    await sendStartScreen(ctx, buildStartCaption(extraLines));
  });

  bot.command("offer", async (ctx) => {
    await showOffer(ctx);
  });

  bot.command("promo", async (ctx) => {
    const required = await requireUser(ctx);
    if (!required) return;

    const text = ctx.message?.text ?? "";
    const spaceIndex = text.indexOf(" ");
    const codeRaw = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
    if (!codeRaw.length) {
      // Без аргумента — открываем диалоговый ввод.
      promoSessions.delete(required.telegramId);
      await openPromoDialog(ctx);
      return;
    }

    promoSessions.delete(required.telegramId);
    await applyPromoCode(ctx, required, codeRaw);
  });

  bot.command("devices", async (ctx) => {
    const required = await requireUser(ctx);
    if (!required) return;

    await showDevicesMenu(ctx, required.user.id);
  });

  // Callback for device management
  bot.callbackQuery(/^devices:(.+)$/, async (ctx) => {
    const required = await requireUser(ctx);
    if (!required) return;

    const action = ctx.match[1];
    await ctx.answerCallbackQuery().catch(() => { });

    if (action === "list") {
      await showDevicesMenu(ctx, required.user.id);
    } else if (action.startsWith("remove:")) {
      const deviceId = action.replace("remove:", "");
      const success = await deps.devices.removeDevice(required.user.id, deviceId);

      if (success) {
        await ctx.answerCallbackQuery({ text: "✅ Устройство удалено" }).catch(() => { });
        await showDevicesMenu(ctx, required.user.id);
      } else {
        await ctx.answerCallbackQuery({ text: "❌ Ошибка удаления" }).catch(() => { });
      }
    } else if (action === "buy_slot") {
      // Navigate to buy slot (will implement next)
      await showBuyDeviceSlotMenu(ctx, required.user.telegramId);
    }
  });

  bot.command("delete_user", async (ctx) => {
    if (!isAdmin(ctx)) {
      await replyOrEdit(ctx, "⛔ Недостаточно прав");
      return;
    }
    if (!ctx.from?.id) return;

    const text = ctx.message?.text ?? "";
    const args = text.trim().split(/\s+/).slice(1);
    const targetTelegramId = String(args[0] ?? "").trim();

    if (!/^\d{1,20}$/.test(targetTelegramId)) {
      await replyOrEdit(ctx, "Формат: /delete_user <telegramId>");
      return;
    }

    if (deps.adminUserIds.has(targetTelegramId)) {
      await replyOrEdit(ctx, "⛔ Нельзя удалить администратора");
      return;
    }

    const adminTelegramId = String(ctx.from.id);
    try {
      const result = await deps.adminDeletion.deleteUserWithoutBan({ adminTelegramId, targetTelegramId });
      if (result.status === "not_found") {
        await replyOrEdit(ctx, "ℹ️ Пользователь не найден");
        return;
      }

      await replyOrEdit(ctx, `🧹 Пользователь <code>${escapeHtml(result.targetTelegramId)}</code> удалён (без бана)`, { parse_mode: "HTML" });
      await ctx.api
        .sendMessage(Number(result.targetTelegramId), "Ваш аккаунт LisVPN был удалён администратором. Вы можете зарегистрироваться снова: /start")
        .catch(() => { });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("delete_user failed", { adminTelegramId, targetTelegramId, errorName: e?.name, errorMessage: e?.message });
      await replyOrEdit(ctx, "❌ Не удалось удалить пользователя. Подробности в логах.");
    }
  });

  bot.command("ban_user", async (ctx) => {
    if (!isAdmin(ctx)) {
      await replyOrEdit(ctx, "⛔ Недостаточно прав");
      return;
    }
    if (!ctx.from?.id) return;

    const text = ctx.message?.text ?? "";
    const parts = text.trim().split(/\s+/).slice(1);
    const targetTelegramId = String(parts[0] ?? "").trim();
    const reason = parts.slice(1).join(" ").trim();

    if (!/^\d{1,20}$/.test(targetTelegramId)) {
      await replyOrEdit(ctx, "Формат: /ban_user <telegramId> [reason]");
      return;
    }
    if (deps.adminUserIds.has(targetTelegramId)) {
      await replyOrEdit(ctx, "⛔ Нельзя заблокировать администратора");
      return;
    }

    const adminTelegramId = String(ctx.from.id);
    try {
      const result = await deps.adminBans.banUserByTelegramId({ adminTelegramId, targetTelegramId, ...(reason ? { reason } : {}) });
      const reasonFinal = (result.reason ?? reason ?? "").trim() || "не указана";
      await replyOrEdit(
        ctx,
        [`⛔ Пользователь <code>${escapeHtml(result.targetTelegramId)}</code> заблокирован`, `Причина: ${escapeHtml(reasonFinal)}`].join("\n"),
        { parse_mode: "HTML" },
      );
      await ctx.api.sendMessage(Number(result.targetTelegramId), blockedText).catch(() => { });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("ban_user failed", { adminTelegramId, targetTelegramId, errorName: e?.name, errorMessage: e?.message });
      await replyOrEdit(ctx, "❌ Не удалось заблокировать пользователя. Подробности в логах.");
    }
  });

  bot.command("unban_user", async (ctx) => {
    if (!isAdmin(ctx)) {
      await replyOrEdit(ctx, "⛔ Недостаточно прав");
      return;
    }
    if (!ctx.from?.id) return;

    const text = ctx.message?.text ?? "";
    const parts = text.trim().split(/\s+/).slice(1);
    const targetTelegramId = String(parts[0] ?? "").trim();

    if (!/^\d{1,20}$/.test(targetTelegramId)) {
      await replyOrEdit(ctx, "Формат: /unban_user <telegramId>");
      return;
    }

    const adminTelegramId = String(ctx.from.id);
    try {
      const result = await deps.adminBans.unbanUserByTelegramId({ adminTelegramId, targetTelegramId });
      await replyOrEdit(
        ctx,
        result.removed ? `🔓 Пользователь <code>${escapeHtml(targetTelegramId)}</code> разблокирован` : "ℹ️ Пользователь не был заблокирован",
        { parse_mode: "HTML" },
      );
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("unban_user failed", { adminTelegramId, targetTelegramId, errorName: e?.name, errorMessage: e?.message });
      await replyOrEdit(ctx, "❌ Не удалось разблокировать пользователя. Подробности в логах.");
    }
  });

  bot.command("msg", async (ctx) => {
    if (!isAdmin(ctx)) {
      await replyOrEdit(ctx, "⛔ Недостаточно прав");
      return;
    }
    if (!ctx.from?.id) return;

    const text = ctx.message?.text ?? "";
    const parts = text.trim().split(/\s+/).slice(1);
    const targetTelegramId = String(parts[0] ?? "").trim();
    const messageText = parts.slice(1).join(" ").trim();

    if (!/^\d{1,20}$/.test(targetTelegramId) || !messageText) {
      await replyOrEdit(ctx, "Формат: /msg <telegramId> <сообщение>");
      return;
    }

    try {
      await ctx.api.sendMessage(Number(targetTelegramId), messageText);
      await replyOrEdit(ctx, `✅ Сообщение отправлено пользователю <code>${escapeHtml(targetTelegramId)}</code>`, { parse_mode: "HTML" });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("msg failed", { adminTelegramId: ctx.from.id, targetTelegramId, errorName: e?.name, errorMessage: e?.message });
      await replyOrEdit(ctx, "❌ Не удалось отправить сообщение. Возможно, пользователь заблокировал бота или ID неверен.");
    }
  });

  bot.command("addpromo", async (ctx) => {
    if (!isAdmin(ctx)) {
      await replyOrEdit(ctx, "⛔ Команда доступна только администратору");
      return;
    }

    const text = ctx.message?.text ?? "";
    const args = text.trim().split(/\s+/).slice(1);

    const codeRaw = args[0] ?? "";
    const daysRaw = args[1] ?? "";
    const maxUsesRaw = args[2];
    const expiresAtRaw = args[3];

    if (!codeRaw.trim().length || !daysRaw.trim().length || args.length < 2 || args.length > 4) {
      await replyOrEdit(ctx, "Формат: /addpromo <code> <days> [maxUses] [expiresAt]\nПример: /addpromo PARTNER2026 30 50 2026-03-01");
      return;
    }

    const bonusDays = Number.parseInt(daysRaw, 10);
    if (!Number.isFinite(bonusDays) || bonusDays <= 0) {
      await replyOrEdit(ctx, "❌ days должен быть целым числом > 0");
      return;
    }

    let maxUses: number | null | undefined;
    if (maxUsesRaw !== undefined) {
      const parsed = Number.parseInt(maxUsesRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        await replyOrEdit(ctx, "❌ maxUses должен быть целым числом > 0");
        return;
      }
      maxUses = parsed;
    }

    let expiresAt: Date | null | undefined;
    if (expiresAtRaw !== undefined) {
      const parsed = parseExpiresAt(expiresAtRaw);
      if (!parsed) {
        await replyOrEdit(ctx, "❌ expiresAt должен быть в формате YYYY-MM-DD (например, 2026-03-01)");
        return;
      }
      expiresAt = parsed;
    }

    const created = await deps.promos.addPromo({ code: codeRaw, bonusDays, maxUses, expiresAt });
    if (!created.ok) {
      await replyOrEdit(ctx, "❌ Такой промокод уже существует");
      return;
    }

    await replyOrEdit(ctx, `✅ Промокод добавлен: ${created.promo.code}, ${created.promo.bonusDays} дней`);
  });

  // Админ-команда для ручного увеличения лимита устройств
  bot.command("addslot", async (ctx) => {
    if (!isAdmin(ctx)) {
      await replyOrEdit(ctx, "⛔ Команда доступна только администратору");
      return;
    }

    const text = ctx.message?.text ?? "";
    const args = text.trim().split(/\s+/).slice(1);

    const targetTelegramId = String(args[0] ?? "").trim();
    const countRaw = args[1] ?? "1";

    if (!/^\d{1,20}$/.test(targetTelegramId)) {
      await replyOrEdit(ctx, "Формат: /addslot <telegramId> [count]\nПример: /addslot 123456789 2");
      return;
    }

    const count = Number.parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count <= 0 || count > 10) {
      await replyOrEdit(ctx, "❌ count должен быть целым числом от 1 до 10");
      return;
    }

    try {
      // Найти пользователя
      const user = await deps.prisma.user.findUnique({
        where: { telegramId: targetTelegramId },
      });

      if (!user) {
        await replyOrEdit(ctx, `❌ Пользователь с telegramId <code>${escapeHtml(targetTelegramId)}</code> не найден`, { parse_mode: "HTML" });
        return;
      }

      // Найти подписку
      const subscription = await deps.prisma.subscription.findUnique({
        where: { userId: user.id },
      });

      if (!subscription) {
        await replyOrEdit(ctx, `❌ У пользователя <code>${escapeHtml(targetTelegramId)}</code> нет подписки`, { parse_mode: "HTML" });
        return;
      }

      // Увеличить deviceLimit
      const updated = await deps.prisma.subscription.update({
        where: { id: subscription.id },
        data: { deviceLimit: subscription.deviceLimit + count },
      });

      await replyOrEdit(
        ctx,
        [
          "✅ Слоты добавлены",
          `👤 Пользователь: <code>${escapeHtml(targetTelegramId)}</code>`,
          `➕ Добавлено: ${count}`,
          `📱 Новый лимит устройств: ${updated.deviceLimit}`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("addslot failed", { targetTelegramId, count, errorName: e?.name, errorMessage: e?.message });
      await replyOrEdit(ctx, "❌ Не удалось добавить слоты. Подробности в логах.");
    }
  });

  bot.hears("🏠 Личный кабинет", showCabinet);
  bot.hears("🆘 Поддержка", showSupport);
  bot.hears("📱 Мои устройства", async (ctx) => {
    const required = await requireUser(ctx);
    if (!required) return;
    await showDevicesMenu(ctx, required.user.id);
  });

  bot.callbackQuery("nav:cabinet", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCabinet(ctx);
  });
  bot.callbackQuery("menu:main", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCabinet(ctx);
  });
  bot.callbackQuery("nav:sub", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMySubscription(ctx);
  });
  bot.callbackQuery("nav:buy", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showBuyConfig(ctx, CheckoutFlow.BUY, 30, MIN_DEVICE_LIMIT);
  });
  bot.callbackQuery("nav:devices", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDevices(ctx);
  });
  bot.callbackQuery("nav:ref", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showReferral(ctx);
  });
  // Backward-compat: old inline buttons may still use "nav:friends".
  bot.callbackQuery("nav:friends", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showReferral(ctx);
  });
  bot.callbackQuery("nav:guide", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGuide(ctx);
  });

  bot.callbackQuery("nav:support", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSupport(ctx);
  });
  bot.callbackQuery("nav:promo", async (ctx) => {
    await ctx.answerCallbackQuery();
    await openPromoDialog(ctx);
  });

  bot.callbackQuery("promo:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from?.id) promoSessions.delete(String(ctx.from.id));
    await showCabinet(ctx);
  });


  bot.callbackQuery(/^buy:cfg:(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    const devices = Number(ctx.match[2]);
    await showBuyConfig(ctx, CheckoutFlow.BUY, days, devices);
  });

  bot.callbackQuery(/^buy:dev:(inc|dec|noop):(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match[1] as "inc" | "dec" | "noop";
    const days = Number(ctx.match[2]) as 30 | 90 | 180;
    const devices = Number(ctx.match[3]);

    if (action === "noop") {
      await showBuyConfig(ctx, CheckoutFlow.BUY, days, devices);
      return;
    }

    const next = action === "inc" ? devices + 1 : devices - 1;
    await showBuyConfig(ctx, CheckoutFlow.BUY, days, next);
  });

  bot.callbackQuery(/^buy:pay:(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    const devices = Number(ctx.match[2]);
    await showBuyMethod(ctx, CheckoutFlow.BUY, days, devices);
  });

  bot.callbackQuery(/^buy:do:(yoo|cb):(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const providerRaw = ctx.match[1] as "yoo" | "cb";
    const planDays = Number(ctx.match[2]) as 30 | 90 | 180;
    const deviceLimit = Number(ctx.match[3]);
    await startSubscriptionCheckout(ctx, CheckoutFlow.BUY, providerRaw, planDays, deviceLimit);
  });

  bot.callbackQuery("ext:open", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showBuyConfig(ctx, CheckoutFlow.EXTEND, 30, MIN_DEVICE_LIMIT);
  });

  bot.callbackQuery(/^ext:cfg:(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    const devices = Number(ctx.match[2]);
    await showBuyConfig(ctx, CheckoutFlow.EXTEND, days, devices);
  });

  bot.callbackQuery(/^ext:dev:(inc|dec|noop):(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match[1] as "inc" | "dec" | "noop";
    const days = Number(ctx.match[2]) as 30 | 90 | 180;
    const devices = Number(ctx.match[3]);

    if (action === "noop") {
      await showBuyConfig(ctx, CheckoutFlow.EXTEND, days, devices);
      return;
    }

    const next = action === "inc" ? devices + 1 : devices - 1;
    await showBuyConfig(ctx, CheckoutFlow.EXTEND, days, next);
  });

  bot.callbackQuery(/^ext:pay:(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const days = Number(ctx.match[1]) as 30 | 90 | 180;
    const devices = Number(ctx.match[2]);
    await showBuyMethod(ctx, CheckoutFlow.EXTEND, days, devices);
  });

  bot.callbackQuery(/^ext:do:(yoo|cb):(30|90|180):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const providerRaw = ctx.match[1] as "yoo" | "cb";
    const planDays = Number(ctx.match[2]) as 30 | 90 | 180;
    const deviceLimit = Number(ctx.match[3]);
    await startSubscriptionCheckout(ctx, CheckoutFlow.EXTEND, providerRaw, planDays, deviceLimit);
  });

  // Device slot payment
  bot.callbackQuery(/^device_slot:pay:(yookassa|cryptobot)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const required = await requireUser(ctx);
    if (!required) return;

    const provider = ctx.match[1] === "yookassa" ? PaymentProvider.YOOKASSA : PaymentProvider.CRYPTOBOT;

    try {
      const result = await deps.payments.createDeviceSlotCheckout({ telegramId: required.user.telegramId, provider });

      const text = [
        "💳 <b>Счёт готов</b>",
        "",
        "Нажми кнопку ниже или скопируй ссылку:",
        `<code>${escapeHtml(result.payUrl)}</code>`,
        "",
        "<i>🦊 После оплаты слот добавится автоматически.</i>",
      ].join("\n");

      const keyboard = new InlineKeyboard()
        .url("💳 Оплатить", result.payUrl).row()
        .text("🔙 К слоту", "devices:buy_slot").row()
        .text("🏠 Личный кабинет", "nav:cabinet").row()
        .add(supportButton(deps, "🆘 Поддержка"));

      await replyOrEdit(ctx, text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch (err: any) {
      if (err?.message === "Subscription is not active") {
        await replyOrEdit(ctx, "Докупка устройства доступна только при активной подписке. Сначала оформи/продли подписку.", { reply_markup: backToCabinetKeyboard(deps) });
        return;
      }
      await replyOrEdit(ctx,
        `❌ Ошибка создания счёта: ${escapeHtml(String(err?.message ?? "Неизвестная ошибка"))}`,
        { parse_mode: "HTML", reply_markup: backToCabinetKeyboard(deps) }
      );
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

      const msg = buildCheckoutMessage(created.payUrl);
      await replyOrEdit(ctx, msg.text, { parse_mode: msg.parse_mode, reply_markup: msg.reply_markup });
    } catch (e: any) {
      if (e?.name === "OfferNotAcceptedError") {
        await showOfferOnceAndRecord(ctx, String(ctx.from.id));
        const created = await deps.payments.createDeviceSlotCheckout({
          telegramId: String(ctx.from.id),
          provider,
        });
        const msg = buildCheckoutMessage(created.payUrl);
        await replyOrEdit(ctx, msg.text, { parse_mode: msg.parse_mode, reply_markup: msg.reply_markup });
        return;
      }
      // eslint-disable-next-line no-console
      console.error("createDeviceSlotCheckout failed", e);
      await replyOrEdit(ctx, "Не получилось создать оплату. Попробуй ещё раз или напиши в поддержку.", { reply_markup: backToCabinetKeyboard(deps) });
    } finally {
      unlock(lockKey);
    }
  });

  bot.callbackQuery(/^guide:(android|ios|desktop)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGuide(ctx);
  });

  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Bot error", err);
  });

  return bot;
}
