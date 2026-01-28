import type { PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import { GrammyError, HttpError } from "grammy";

type BroadcastSession =
  | Readonly<{ stage: "await_text"; startedAtMs: number }>
  | Readonly<{ stage: "await_confirm"; startedAtMs: number; text: string; recipientIds: readonly string[] }>;

type BroadcastStats = Readonly<{ total: number; sent: number; failed: number }>;

const SESSION_TTL_MS = 10 * 60 * 1000;
const PER_MESSAGE_DELAY_MIN_MS = 40;
const PER_MESSAGE_DELAY_MAX_MS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(low + Math.random() * (high - low + 1));
}

function parseCooldownMsFromEnv(): number {
  const raw = (process.env.BROADCAST_COOLDOWN_SECONDS ?? "").trim();
  if (!raw.length) return 0;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid BROADCAST_COOLDOWN_SECONDS: ${raw}`);
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Invalid BROADCAST_COOLDOWN_SECONDS: ${raw}`);
  return seconds * 1000;
}

function isTelegramId(value: string): boolean {
  return /^\d{1,20}$/.test(value.trim());
}

async function listRecipientTelegramIds(prisma: PrismaClient): Promise<readonly string[]> {
  const [users, blocked] = await Promise.all([
    prisma.user.findMany({ select: { telegramId: true } }),
    prisma.blockedUser.findMany({ select: { telegramId: true } }),
  ]);

  const blockedSet = new Set<string>();
  for (const row of blocked) blockedSet.add(String(row.telegramId));

  const result: string[] = [];
  for (const row of users) {
    const telegramId = String(row.telegramId);
    if (!isTelegramId(telegramId)) continue;
    if (blockedSet.has(telegramId)) continue;
    result.push(telegramId);
  }
  return result;
}

function extractRetryAfterSeconds(err: unknown): number | null {
  if (err && typeof err === "object") {
    const anyErr = err as any;
    const retry = anyErr?.error?.parameters?.retry_after ?? anyErr?.parameters?.retry_after;
    if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) return retry;
  }
  return null;
}

function errorSummary(err: unknown): string {
  if (err instanceof GrammyError) {
    const code = err.error?.error_code;
    const desc = err.error?.description;
    return `GrammyError ${code ?? "?"}: ${desc ?? "unknown"}`;
  }
  if (err instanceof HttpError) return `HttpError: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function sendBroadcast(bot: Bot, text: string, recipientIds: readonly string[]): Promise<BroadcastStats> {
  const total = recipientIds.length;
  // eslint-disable-next-line no-console
  console.log("[broadcast] start", { total });

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipientIds.length; i++) {
    const telegramId = recipientIds[i]!;

    let attempt = 0;
    while (attempt < 3) {
      attempt++;
      try {
        await bot.api.sendMessage(telegramId, text, { link_preview_options: { is_disabled: true } });
        sent++;
        break;
      } catch (err) {
        const retryAfter = extractRetryAfterSeconds(err);
        if (retryAfter !== null && attempt < 3) {
          // eslint-disable-next-line no-console
          console.warn("[broadcast] rate limit", { telegramId, retryAfterSeconds: retryAfter });
          await sleep((retryAfter + 1) * 1000);
          continue;
        }

        failed++;
        // eslint-disable-next-line no-console
        console.warn("[broadcast] send failed", { telegramId, error: errorSummary(err) });
        break;
      }
    }

    await sleep(randomInt(PER_MESSAGE_DELAY_MIN_MS, PER_MESSAGE_DELAY_MAX_MS));
  }

  // eslint-disable-next-line no-console
  console.log("[broadcast] done", { total, sent, failed });
  return { total, sent, failed };
}

export function registerBroadcast(bot: Bot, prisma: PrismaClient, isAdmin: (ctx: any) => boolean): void {
  const sessions = new Map<string, BroadcastSession>();
  let broadcastInProgress = false;
  let lastBroadcastAtMs = 0;
  const cooldownMs = parseCooldownMsFromEnv();

  const clearSession = (telegramId: string): void => {
    sessions.delete(telegramId);
  };

  bot.on("message:text", async (ctx, next) => {
    const telegramId = ctx.from?.id ? String(ctx.from.id) : null;
    if (!telegramId || !isAdmin(ctx)) return next();

    const session = sessions.get(telegramId);
    if (!session) return next();

    if (Date.now() - session.startedAtMs > SESSION_TTL_MS) {
      clearSession(telegramId);
      await ctx.reply("⏳ Сессия рассылки истекла. Введи /broadcast заново.", { link_preview_options: { is_disabled: true } });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const trimmed = rawText.trim();
    const upper = trimmed.toUpperCase();

    if (session.stage === "await_text") {
      if (trimmed.startsWith("/broadcast")) {
        await ctx.reply("✉️ Отправь текст рассылки", { link_preview_options: { is_disabled: true } });
        return;
      }

      if (upper === "CANCEL") {
        clearSession(telegramId);
        await ctx.reply("✅ Отменено", { link_preview_options: { is_disabled: true } });
        return;
      }

      if (!trimmed.length) {
        await ctx.reply("❌ Текст не должен быть пустым. Пришли текст рассылки или напиши CANCEL.", { link_preview_options: { is_disabled: true } });
        return;
      }

      if (rawText.length > 4096) {
        await ctx.reply("❌ Текст слишком длинный (Telegram ограничивает сообщение 4096 символами). Пришли текст короче или напиши CANCEL.", {
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      const recipientIds = await listRecipientTelegramIds(prisma);
      sessions.set(telegramId, { stage: "await_confirm", startedAtMs: session.startedAtMs, text: rawText, recipientIds });

      const header = [
        "👥 Пользователей: " + recipientIds.length,
        "",
        "Текст рассылки ниже 👇",
        "",
        "Напиши CONFIRM для отправки",
        "или CANCEL для отмены",
      ].join("\n");
      await ctx.reply(header, { link_preview_options: { is_disabled: true } });
      await ctx.reply(rawText, { link_preview_options: { is_disabled: true } });
      return;
    }

    if (upper === "CANCEL") {
      clearSession(telegramId);
      await ctx.reply("✅ Отменено", { link_preview_options: { is_disabled: true } });
      return;
    }

    if (upper !== "CONFIRM") {
      await ctx.reply("Напиши CONFIRM для отправки или CANCEL для отмены.", { link_preview_options: { is_disabled: true } });
      return;
    }

    if (broadcastInProgress) {
      await ctx.reply("⏳ Рассылка уже идёт. Дождись завершения.", { link_preview_options: { is_disabled: true } });
      return;
    }

    const now = Date.now();
    if (cooldownMs > 0 && now - lastBroadcastAtMs < cooldownMs) {
      const secondsLeft = Math.ceil((cooldownMs - (now - lastBroadcastAtMs)) / 1000);
      await ctx.reply(`⏳ Слишком часто. Подожди ${secondsLeft} сек.`, { link_preview_options: { is_disabled: true } });
      return;
    }

    clearSession(telegramId);
    broadcastInProgress = true;
    lastBroadcastAtMs = now;

    await ctx.reply("🚀 Начинаю рассылку. Прогресс смотри в логах сервера.", { link_preview_options: { is_disabled: true } });

    const textToSend = session.text;
    const recipients = session.recipientIds;

    void (async () => {
      try {
        await sendBroadcast(bot, textToSend, recipients);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[broadcast] fatal", { error: errorSummary(err) });
      } finally {
        broadcastInProgress = false;
      }
    })();
  });

  bot.command("broadcast", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply("⛔ Команда доступна только администратору", { link_preview_options: { is_disabled: true } });
      return;
    }
    if (!ctx.from?.id) return;

    if (broadcastInProgress) {
      await ctx.reply("⏳ Рассылка уже идёт. Дождись завершения.", { link_preview_options: { is_disabled: true } });
      return;
    }

    sessions.set(String(ctx.from.id), { stage: "await_text", startedAtMs: Date.now() });
    await ctx.reply("✉️ Отправь текст рассылки", { link_preview_options: { is_disabled: true } });
  });
}
