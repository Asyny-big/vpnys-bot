import type { PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import { GrammyError, HttpError } from "grammy";

type BroadcastPayload =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "photo"; fileId: string; caption?: string }>
  | Readonly<{ kind: "video"; fileId: string; caption?: string }>
  | Readonly<{ kind: "document"; fileId: string; caption?: string; fileName?: string }>;

type BroadcastSession =
  | Readonly<{ stage: "await_content"; startedAtMs: number }>
  | Readonly<{ stage: "await_confirm"; startedAtMs: number; payload: BroadcastPayload; recipientIds: readonly string[] }>;

type BroadcastStats = Readonly<{ total: number; sent: number; failed: number }>;

const SESSION_TTL_MS = 10 * 60 * 1000;
const PER_MESSAGE_DELAY_MIN_MS = 40;
const PER_MESSAGE_DELAY_MAX_MS = 60;
const MAX_TEXT_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;

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
    const retry = anyErr?.parameters?.retry_after ?? anyErr?.error?.parameters?.retry_after;
    if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) return retry;
  }
  return null;
}

function errorSummary(err: unknown): string {
  if (err instanceof GrammyError) {
    return `GrammyError ${err.error_code}: ${err.description}`;
  }
  if (err && typeof err === "object" && "error" in err) {
    const inner = (err as any).error;
    if (inner instanceof GrammyError) return `GrammyError ${inner.error_code}: ${inner.description}`;
    if (inner instanceof HttpError) return `HttpError: ${inner.message}`;
    if (inner instanceof Error) return `${inner.name}: ${inner.message}`;
  }
  if (err instanceof HttpError) return `HttpError: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function normalizeOptionalCaption(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const caption = value.trim();
  return caption.length ? value : undefined;
}

function extractBroadcastPayload(ctx: any): BroadcastPayload | null {
  const message = ctx.message;
  if (!message) return null;

  if (typeof message.text === "string") {
    return { kind: "text", text: message.text };
  }

  if (message.media_group_id) return null;

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    const fileId = photo?.file_id;
    if (typeof fileId === "string" && fileId.length) {
      return { kind: "photo", fileId, caption: normalizeOptionalCaption(message.caption) };
    }
  }

  const videoFileId = message.video?.file_id;
  if (typeof videoFileId === "string" && videoFileId.length) {
    return { kind: "video", fileId: videoFileId, caption: normalizeOptionalCaption(message.caption) };
  }

  const documentFileId = message.document?.file_id;
  if (typeof documentFileId === "string" && documentFileId.length) {
    return {
      kind: "document",
      fileId: documentFileId,
      caption: normalizeOptionalCaption(message.caption),
      fileName: typeof message.document?.file_name === "string" ? message.document.file_name : undefined,
    };
  }

  return null;
}

function validateBroadcastPayload(payload: BroadcastPayload): string | null {
  if (payload.kind === "text") {
    if (!payload.text.trim().length) return "❌ Текст не должен быть пустым. Пришли текст рассылки или напиши CANCEL.";
    if (payload.text.length > MAX_TEXT_LENGTH) {
      return "❌ Текст слишком длинный (Telegram ограничивает сообщение 4096 символами). Пришли текст короче или напиши CANCEL.";
    }
    return null;
  }

  if (payload.caption && payload.caption.length > MAX_CAPTION_LENGTH) {
    return "❌ Подпись слишком длинная (Telegram ограничивает caption 1024 символами). Пришли медиа с более короткой подписью или напиши CANCEL.";
  }

  return null;
}

function describePayload(payload: BroadcastPayload): string {
  switch (payload.kind) {
    case "text":
      return "текст";
    case "photo":
      return payload.caption ? "фото с подписью" : "фото";
    case "video":
      return payload.caption ? "видео с подписью" : "видео";
    case "document":
      return payload.caption ? "файл с подписью" : "файл";
  }
}

async function previewBroadcastPayload(ctx: any, payload: BroadcastPayload): Promise<void> {
  if (payload.kind === "text") {
    await ctx.reply(payload.text, { link_preview_options: { is_disabled: true } });
    return;
  }

  if (payload.kind === "photo") {
    await ctx.replyWithPhoto(payload.fileId, payload.caption ? { caption: payload.caption } : {});
    return;
  }

  if (payload.kind === "video") {
    await ctx.replyWithVideo(payload.fileId, payload.caption ? { caption: payload.caption } : {});
    return;
  }

  await ctx.replyWithDocument(payload.fileId, payload.caption ? { caption: payload.caption } : {});
}

async function sendBroadcastPayload(bot: Bot, telegramId: string, payload: BroadcastPayload): Promise<void> {
  if (payload.kind === "text") {
    await bot.api.sendMessage(telegramId, payload.text, { link_preview_options: { is_disabled: true } });
    return;
  }

  if (payload.kind === "photo") {
    await bot.api.sendPhoto(telegramId, payload.fileId, payload.caption ? { caption: payload.caption } : {});
    return;
  }

  if (payload.kind === "video") {
    await bot.api.sendVideo(telegramId, payload.fileId, payload.caption ? { caption: payload.caption } : {});
    return;
  }

  await bot.api.sendDocument(telegramId, payload.fileId, payload.caption ? { caption: payload.caption } : {});
}

async function sendBroadcast(bot: Bot, payload: BroadcastPayload, recipientIds: readonly string[]): Promise<BroadcastStats> {
  const total = recipientIds.length;
  // eslint-disable-next-line no-console
  console.log("[broadcast] start", { total, kind: payload.kind });

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipientIds.length; i++) {
    const telegramId = recipientIds[i]!;

    let attempt = 0;
    while (attempt < 3) {
      attempt++;
      try {
        await sendBroadcastPayload(bot, telegramId, payload);
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
        console.warn("[broadcast] send failed", { telegramId, kind: payload.kind, error: errorSummary(err) });
        break;
      }
    }

    await sleep(randomInt(PER_MESSAGE_DELAY_MIN_MS, PER_MESSAGE_DELAY_MAX_MS));
  }

  // eslint-disable-next-line no-console
  console.log("[broadcast] done", { total, sent, failed, kind: payload.kind });
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

  bot.on("message", async (ctx, next) => {
    const telegramId = ctx.from?.id ? String(ctx.from.id) : null;
    if (!telegramId || !isAdmin(ctx)) return next();

    const session = sessions.get(telegramId);
    if (!session) return next();

    if (Date.now() - session.startedAtMs > SESSION_TTL_MS) {
      clearSession(telegramId);
      await ctx.reply("⏳ Сессия рассылки истекла. Введи /broadcast заново.", { link_preview_options: { is_disabled: true } });
      return;
    }

    const payload = extractBroadcastPayload(ctx);
    const messageText = typeof ctx.message?.text === "string" ? ctx.message.text : "";
    const trimmedText = messageText.trim();
    const upperText = trimmedText.toUpperCase();

    if (session.stage === "await_content") {
      if (trimmedText.startsWith("/broadcast")) {
        await ctx.reply("✉️ Отправь текст, фото, видео или файл для рассылки", { link_preview_options: { is_disabled: true } });
        return;
      }

      if (upperText === "CANCEL") {
        clearSession(telegramId);
        await ctx.reply("✅ Отменено", { link_preview_options: { is_disabled: true } });
        return;
      }

      if (ctx.message?.media_group_id) {
        await ctx.reply("❌ Альбомы не поддерживаются. Пришли один объект: текст, фото, видео или файл.", {
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      if (!payload) {
        await ctx.reply("❌ Поддерживаются только текст, фото, видео и файл. Пришли нужный формат или напиши CANCEL.", {
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      const validationError = validateBroadcastPayload(payload);
      if (validationError) {
        await ctx.reply(validationError, { link_preview_options: { is_disabled: true } });
        return;
      }

      const recipientIds = await listRecipientTelegramIds(prisma);
      sessions.set(telegramId, { stage: "await_confirm", startedAtMs: session.startedAtMs, payload, recipientIds });

      const header = [
        `👥 Пользователей: ${recipientIds.length}`,
        `📦 Формат: ${describePayload(payload)}`,
        "",
        "Предпросмотр рассылки ниже 👇",
        "",
        "Напиши CONFIRM для отправки",
        "или CANCEL для отмены",
      ].join("\n");
      await ctx.reply(header, { link_preview_options: { is_disabled: true } });
      await previewBroadcastPayload(ctx, payload);
      return;
    }

    if (upperText === "CANCEL") {
      clearSession(telegramId);
      await ctx.reply("✅ Отменено", { link_preview_options: { is_disabled: true } });
      return;
    }

    if (upperText !== "CONFIRM") {
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

    const payloadToSend = session.payload;
    const recipients = session.recipientIds;

    void (async () => {
      try {
        await sendBroadcast(bot, payloadToSend, recipients);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[broadcast] fatal", { kind: payloadToSend.kind, error: errorSummary(err) });
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

    sessions.set(String(ctx.from.id), { stage: "await_content", startedAtMs: Date.now() });
    await ctx.reply("✉️ Отправь текст, фото, видео или файл для рассылки", { link_preview_options: { is_disabled: true } });
  });
}
