import type { Prisma, PrismaClient } from "@prisma/client";
import { ThreeXUiService } from "../../integrations/threeXui/threeXuiService";

export type XuiBanOutcome = Readonly<
  | { attempted: false }
  | { attempted: true; method: "delete"; ok: true; details?: string }
  | { attempted: true; method: "disable"; ok: true; details?: string }
  | { attempted: true; method: "delete"; ok: false; errorName?: string; errorMessage?: string; details?: string }
  | { attempted: true; method: "disable"; ok: false; errorName?: string; errorMessage?: string; details?: string }
>;

function parseTelegramIdToBigInt(telegramId: string): bigint {
  const trimmed = telegramId.trim();
  if (!/^\d{1,20}$/.test(trimmed)) throw new Error(`Invalid telegramId: ${telegramId}`);
  return BigInt(trimmed);
}

export type BanUserResult = Readonly<{
  status: "banned";
  targetTelegramId: string;
  blockedAlready: boolean;
  deletedFromDb: boolean;
  xui: XuiBanOutcome;
  reason?: string;
}>;

export type UnbanUserResult = Readonly<{ status: "unbanned"; removed: boolean }>;

export class AdminUserBanService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly xui: ThreeXUiService,
    private readonly adminUserIds: ReadonlySet<string>,
  ) {}

  private async deleteUserDataInTransaction(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.referral.deleteMany({ where: { OR: [{ invitedId: userId }, { inviterId: userId }] } });
    await tx.subscription.deleteMany({ where: { userId } });
    await tx.promoCodeUse.deleteMany({ where: { userId } });
    await tx.payment.deleteMany({ where: { userId } });
    await tx.user.deleteMany({ where: { id: userId } });
  }

  private async bestEffortRemoveFromXui(params: {
    adminTelegramId: string;
    targetTelegramId: string;
    inboundId?: number;
    uuid?: string;
  }): Promise<XuiBanOutcome> {
    if (typeof params.inboundId === "number" && typeof params.uuid === "string" && params.uuid.length) {
      try {
        await this.xui.deleteClient(params.inboundId, params.uuid);
        return { attempted: true, method: "delete", ok: true, details: "by_uuid" } as const;
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error("ban_user xui delete failed", {
          adminTelegramId: params.adminTelegramId,
          targetTelegramId: params.targetTelegramId,
          inboundId: params.inboundId,
          uuid: params.uuid,
          errorName: e?.name,
          errorMessage: e?.message,
        });
        try {
          await this.xui.disable(params.inboundId, params.uuid);
          return { attempted: true, method: "disable", ok: true, details: "by_uuid" } as const;
        } catch (e2: any) {
          // eslint-disable-next-line no-console
          console.error("ban_user xui disable failed", {
            adminTelegramId: params.adminTelegramId,
            targetTelegramId: params.targetTelegramId,
            inboundId: params.inboundId,
            uuid: params.uuid,
            errorName: e2?.name,
            errorMessage: e2?.message,
          });
          return { attempted: true, method: "disable", ok: false, errorName: e2?.name, errorMessage: e2?.message, details: "by_uuid" } as const;
        }
      }
    }

    try {
      const email = this.xui.telegramEmail(params.targetTelegramId);
      const inbounds = await this.xui.listInbounds();
      let matched = 0;
      let usedDisable = false;
      for (const inbound of inbounds) {
        const clients = await this.xui.listClients(inbound.id);
        const hits = clients.filter((c) => c.email === email);
        for (const hit of hits) {
          matched += 1;
          try {
            await this.xui.deleteClient(inbound.id, hit.uuid);
          } catch {
            usedDisable = true;
            await this.xui.disable(inbound.id, hit.uuid);
          }
        }
      }

      if (!matched) return { attempted: false } as const;
      return usedDisable
        ? ({ attempted: true, method: "disable", ok: true, details: `by_email:matches=${matched}` } as const)
        : ({ attempted: true, method: "delete", ok: true, details: `by_email:matches=${matched}` } as const);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("ban_user xui scan failed", {
        adminTelegramId: params.adminTelegramId,
        targetTelegramId: params.targetTelegramId,
        errorName: e?.name,
        errorMessage: e?.message,
      });
      return { attempted: true, method: "delete", ok: false, errorName: e?.name, errorMessage: e?.message, details: "by_email" } as const;
    }
  }

  async banUserByTelegramId(params: { adminTelegramId: string; targetTelegramId: string; reason?: string }): Promise<BanUserResult> {
    const startedAt = new Date();
    const targetTelegramId = params.targetTelegramId.trim();
    const telegramIdBig = parseTelegramIdToBigInt(targetTelegramId);

    if (this.adminUserIds.has(targetTelegramId)) {
      throw new Error("Refusing to ban an admin user");
    }

    const reason = params.reason?.trim().length ? params.reason.trim() : undefined;

    let blockedAlready = false;
    let deletedFromDb = false;
    let xuiInboundId: number | undefined;
    let xuiClientUuid: string | undefined;

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.blockedUser.findUnique({ where: { telegramId: telegramIdBig }, select: { id: true, reason: true } });
      if (existing) {
        blockedAlready = true;
        if (reason && existing.reason !== reason) {
          await tx.blockedUser.update({ where: { telegramId: telegramIdBig }, data: { reason } });
        }
      } else {
        await tx.blockedUser.create({ data: { telegramId: telegramIdBig, reason: reason ?? null } });
      }

      const user = await tx.user.findUnique({
        where: { telegramId: targetTelegramId },
        select: { id: true, subscription: { select: { xuiInboundId: true, xuiClientUuid: true } } },
      });
      if (!user) return;

      deletedFromDb = true;
      xuiInboundId = user.subscription?.xuiInboundId;
      xuiClientUuid = user.subscription?.xuiClientUuid ?? undefined;
      await this.deleteUserDataInTransaction(tx, user.id);
    });

    const xuiResult = await this.bestEffortRemoveFromXui({
      adminTelegramId: params.adminTelegramId,
      targetTelegramId,
      inboundId: xuiInboundId,
      uuid: xuiClientUuid,
    });

    // eslint-disable-next-line no-console
    console.info("ban_user banned", {
      adminTelegramId: params.adminTelegramId,
      targetTelegramId,
      blockedAlready,
      deletedFromDb,
      xui: xuiResult,
      reason,
      at: startedAt.toISOString(),
    });

    return { status: "banned", targetTelegramId, blockedAlready, deletedFromDb, xui: xuiResult, ...(reason ? { reason } : {}) };
  }

  async unbanUserByTelegramId(params: { adminTelegramId: string; targetTelegramId: string }): Promise<UnbanUserResult> {
    const telegramIdBig = parseTelegramIdToBigInt(params.targetTelegramId);
    const removed = await this.prisma.blockedUser.deleteMany({ where: { telegramId: telegramIdBig } });
    // eslint-disable-next-line no-console
    console.info("unban_user", { adminTelegramId: params.adminTelegramId, targetTelegramId: params.targetTelegramId, removed: removed.count });
    return { status: "unbanned", removed: removed.count > 0 };
  }
}

