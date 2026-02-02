import type { PrismaClient } from "@prisma/client";
import type { ThreeXUiService } from "../integrations/threeXui/threeXuiService";
import { SubscriptionStatus } from "../db/values";
import { sendTelegramMessage } from "../utils/telegram";

type Logger = Pick<Console, "info" | "warn" | "error">;

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const workers: Promise<void>[] = [];

  const worker = async (): Promise<void> => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      await handler(item);
    }
  };

  for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
  await Promise.all(workers);
}

export function startSubscriptionWorker(deps: {
  prisma: PrismaClient;
  xui: ThreeXUiService;
  intervalSeconds: number;
  logger?: Logger;
  telegramBotToken?: string;
  telegramBotUrl?: string;
}): { stop: () => void } {
  const logger = deps.logger ?? console;
  let isRunning = false;

  const tick = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      const now = new Date();

      const inboundClientMaps = new Map<number, Map<string, { expiresAt?: Date; enabled: boolean }>>();

      const batchSize = 500;
      const maxBatchesPerTick = 10;
      let cursorId: string | undefined;

      for (let batch = 0; batch < maxBatchesPerTick; batch++) {
        // Use DB cache as a filter only; the source of truth is still 3x-ui.
        const candidates = await deps.prisma.subscription.findMany({
          where: {
            OR: [
              { status: SubscriptionStatus.ACTIVE },
              { enabled: true },
              { expiresAt: { lte: now } },
              { expiresAt: null },
            ],
          },
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
          orderBy: { id: "asc" },
          select: {
            id: true,
            xuiInboundId: true,
            xuiClientUuid: true,
            xuiSubscriptionId: true,
            deviceLimit: true,
          },
          take: batchSize,
        });

        if (candidates.length === 0) break;
        cursorId = candidates[candidates.length - 1]?.id;

        const inboundIds = Array.from(new Set(candidates.map((c) => c.xuiInboundId)));
        // One fetch per inbound per tick (instead of per subscription).
        await runWithConcurrency(inboundIds, 2, async (inboundId) => {
          if (inboundClientMaps.has(inboundId)) return;
          const clients = await deps.xui.listClients(inboundId);
          const map = new Map<string, { expiresAt?: Date; enabled: boolean }>();
          for (const client of clients) {
            map.set(client.uuid, { expiresAt: client.expiresAt, enabled: client.enabled });
          }
          inboundClientMaps.set(inboundId, map);
        });

        await runWithConcurrency(candidates, 10, async (sub) => {
          try {
            const map = inboundClientMaps.get(sub.xuiInboundId);
            const client = map?.get(sub.xuiClientUuid);
            if (!client) {
              logger.warn(`worker: client missing in 3x-ui uuid=${sub.xuiClientUuid}`);
              return;
            }

            // 3x-ui is the source of truth for expiresAt.
            // We only READ from 3x-ui and WRITE to DB. Never push expiresAt to 3x-ui from worker.
            const expiresAt = client.expiresAt;
            const enabled = client.enabled;

            const expired = !!expiresAt && expiresAt.getTime() <= now.getTime();

            if (expired) {
              // Only send notification if subscription was previously enabled (first-time expiration)
              const wasEnabled = enabled;

              if (enabled) {
                await deps.xui.disable(sub.xuiInboundId, sub.xuiClientUuid, sub.deviceLimit);
              }
              await deps.prisma.subscription.update({
                where: { id: sub.id },
                data: {
                  enabled: false,
                  status: SubscriptionStatus.EXPIRED,
                  expiresAt: expiresAt ?? null,
                  lastSyncedAt: new Date(),
                },
              });

              // Send Telegram notification if this is first-time expiration
              if (wasEnabled && deps.telegramBotToken && deps.telegramBotUrl) {
                try {
                  const user = await deps.prisma.user.findFirst({
                    where: { subscription: { id: sub.id } },
                    select: { telegramId: true },
                  });
                  if (user?.telegramId) {
                    const message = [
                      "⛔ Ваша подписка LisVPN закончилась.",
                      "Доступ к VPN временно отключён.",
                      "",
                      "Для продолжения использования:",
                      "• Оплатите подписку",
                      "• Или введите промокод",
                      "",
                      `👉 ${deps.telegramBotUrl}`,
                    ].join("\n");
                    await sendTelegramMessage(deps.telegramBotToken, user.telegramId, message);
                    logger.info(`worker: sent expiration notice to user tg:${user.telegramId}`);
                  }
                } catch (notifyErr: any) {
                  logger.warn(`worker: failed to send expiration notice for sub=${sub.id}: ${notifyErr?.message ?? String(notifyErr)}`);
                }
              }

              return;
            }

            await deps.prisma.subscription.update({
              where: { id: sub.id },
              data: {
                enabled,
                status: enabled ? SubscriptionStatus.ACTIVE : SubscriptionStatus.DISABLED,
                expiresAt: expiresAt ?? null,
                lastSyncedAt: new Date(),
              },
            });
          } catch (e: any) {
            logger.error(`worker: failed sub=${sub.id}: ${e?.message ?? String(e)}`);
          }
        });
      }

      // Enforce bans: even if user rows are deleted, BlockedUser remains the source of truth.
      // Best-effort only (must not break the subscription worker).
      try {
        const blocked = await deps.prisma.blockedUser.findMany({
          select: { telegramId: true },
          take: 500,
        });
        if (blocked.length) {
          const emails = new Set<string>(blocked.map((b) => `tg:${String(b.telegramId)}`));
          const inbounds = await deps.xui.listInbounds();
          await runWithConcurrency(inbounds, 2, async (inbound) => {
            try {
              const clients = await deps.xui.listClients(inbound.id);
              const matches = clients.filter((c) => c.enabled && emails.has(c.email));
              await runWithConcurrency(matches, 10, async (client) => {
                try {
                  await deps.xui.disable(inbound.id, client.uuid);
                  logger.info(`worker: banned client disabled email=${client.email}`);
                } catch (e: any) {
                  logger.error(`worker: failed to disable banned client email=${client.email}: ${e?.message ?? String(e)}`);
                }
              });
            } catch (e: any) {
              logger.error(`worker: ban enforcement failed inbound=${inbound.id}: ${e?.message ?? String(e)}`);
            }
          });
        }
      } catch (e: any) {
        logger.error(`worker: ban enforcement tick failed: ${e?.message ?? String(e)}`);
      }
    } catch (e: any) {
      logger.error(`worker: tick failed: ${e?.message ?? String(e)}`);
    } finally {
      isRunning = false;
    }
  };

  const intervalMs = Math.max(30, deps.intervalSeconds) * 1000;
  // Start quickly, then poll.
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);

  logger.info(`worker: subscription checker started, interval=${intervalMs}ms`);

  return {
    stop: () => clearInterval(timer),
  };
}
