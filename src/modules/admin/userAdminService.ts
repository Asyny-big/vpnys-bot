import type { Prisma, PrismaClient } from "@prisma/client";
import { ThreeXUiService } from "../../integrations/threeXui/threeXuiService";

export type XuiDeleteOutcome = Readonly<
  | { attempted: false }
  | { attempted: true; method: "delete"; ok: true }
  | { attempted: true; method: "disable"; ok: true }
  | { attempted: true; method: "delete"; ok: false; errorName?: string; errorMessage?: string }
  | { attempted: true; method: "disable"; ok: false; errorName?: string; errorMessage?: string }
>;

export type DeleteUserResult = Readonly<
  | {
      status: "deleted";
      userId: string;
      targetTelegramId: string;
      xui: XuiDeleteOutcome;
    }
  | { status: "not_found"; targetTelegramId: string }
>;

export class UserAdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly xui: ThreeXUiService,
  ) {}

  private parseTelegramIdToBigInt(telegramId: string): bigint {
    const trimmed = telegramId.trim();
    if (!/^\d{1,20}$/.test(trimmed)) throw new Error(`Invalid telegramId: ${telegramId}`);
    return BigInt(trimmed);
  }

  private async deleteUserDataInTransaction(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.referral.deleteMany({ where: { OR: [{ invitedId: userId }, { inviterId: userId }] } });
    await tx.subscription.deleteMany({ where: { userId } });
    await tx.promoCodeUse.deleteMany({ where: { userId } });
    await tx.payment.deleteMany({ where: { userId } });
    const deleted = await tx.user.deleteMany({ where: { id: userId } });
    if (deleted.count !== 1) {
      throw new Error(`User delete failed: expected 1 row, got ${deleted.count}`);
    }
  }

  async deleteUserByTelegramId(params: { adminTelegramId: string; targetTelegramId: string }): Promise<DeleteUserResult> {
    const startedAt = new Date();

    const user = await this.prisma.user.findUnique({
      where: { telegramId: params.targetTelegramId },
      select: {
        id: true,
        telegramId: true,
        subscription: { select: { xuiInboundId: true, xuiClientUuid: true } },
      },
    });
    if (!user) {
      // eslint-disable-next-line no-console
      console.warn("delete_user not_found", { adminTelegramId: params.adminTelegramId, targetTelegramId: params.targetTelegramId, at: startedAt.toISOString() });
      return { status: "not_found", targetTelegramId: params.targetTelegramId };
    }

    const inboundId = user.subscription?.xuiInboundId;
    const uuid = user.subscription?.xuiClientUuid;

    await this.prisma.$transaction(async (tx) => {
      await this.deleteUserDataInTransaction(tx, user.id);
    });

    let xuiResult: XuiDeleteOutcome = { attempted: false };
    if (typeof inboundId === "number" && typeof uuid === "string" && uuid.length) {
      try {
        await this.xui.deleteClient(inboundId, uuid);
        xuiResult = { attempted: true, method: "delete", ok: true } as const;
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error("delete_user xui delete failed", {
          adminTelegramId: params.adminTelegramId,
          targetTelegramId: params.targetTelegramId,
          inboundId,
          uuid,
          errorName: e?.name,
          errorMessage: e?.message,
        });
        try {
          await this.xui.disable(inboundId, uuid);
          xuiResult = { attempted: true, method: "disable", ok: true } as const;
        } catch (e2: any) {
          // eslint-disable-next-line no-console
          console.error("delete_user xui disable failed", {
            adminTelegramId: params.adminTelegramId,
            targetTelegramId: params.targetTelegramId,
            inboundId,
            uuid,
            errorName: e2?.name,
            errorMessage: e2?.message,
          });
          xuiResult = { attempted: true, method: "disable", ok: false, errorName: e2?.name, errorMessage: e2?.message } as const;
        }
      }
    }

    // eslint-disable-next-line no-console
    console.info("delete_user deleted", {
      adminTelegramId: params.adminTelegramId,
      targetTelegramId: params.targetTelegramId,
      userId: user.id,
      xui: xuiResult,
      at: startedAt.toISOString(),
    });

    return { status: "deleted", userId: user.id, targetTelegramId: user.telegramId, xui: xuiResult };
  }

  async banUserByTelegramId(params: { adminTelegramId: string; targetTelegramId: string; reason?: string }): Promise<
    Readonly<{
      status: "banned";
      targetTelegramId: string;
      blockedAlready: boolean;
      deletedFromDb: boolean;
      xui: XuiDeleteOutcome;
      reason?: string;
    }>
  > {
    const startedAt = new Date();
    const telegramIdBig = this.parseTelegramIdToBigInt(params.targetTelegramId);
    const reason = params.reason?.trim().length ? params.reason.trim() : undefined;

    let blockedAlready = false;
    let deletedFromDb = false;
    let xuiInboundId: number | undefined;
    let xuiClientUuid: string | undefined;

    await this.prisma.$transaction(async (tx) => {
      if (reason) {
        await tx.blockedUser.upsert({
          where: { telegramId: telegramIdBig },
          create: { telegramId: telegramIdBig, reason },
          update: { reason },
        });
      } else {
        try {
          await tx.blockedUser.create({ data: { telegramId: telegramIdBig } });
        } catch (e: any) {
          if (e?.code !== "P2002") throw e;
          blockedAlready = true;
        }
      }

      const user = await tx.user.findUnique({
        where: { telegramId: params.targetTelegramId },
        select: { id: true, subscription: { select: { xuiInboundId: true, xuiClientUuid: true } } },
      });
      if (!user) return;

      deletedFromDb = true;
      xuiInboundId = user.subscription?.xuiInboundId;
      xuiClientUuid = user.subscription?.xuiClientUuid ?? undefined;
      await this.deleteUserDataInTransaction(tx, user.id);
    });

    let xuiResult: XuiDeleteOutcome = { attempted: false };
    if (typeof xuiInboundId === "number" && typeof xuiClientUuid === "string" && xuiClientUuid.length) {
      try {
        await this.xui.deleteClient(xuiInboundId, xuiClientUuid);
        xuiResult = { attempted: true, method: "delete", ok: true } as const;
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error("ban_user xui delete failed", {
          adminTelegramId: params.adminTelegramId,
          targetTelegramId: params.targetTelegramId,
          inboundId: xuiInboundId,
          uuid: xuiClientUuid,
          errorName: e?.name,
          errorMessage: e?.message,
        });
        try {
          await this.xui.disable(xuiInboundId, xuiClientUuid);
          xuiResult = { attempted: true, method: "disable", ok: true } as const;
        } catch (e2: any) {
          // eslint-disable-next-line no-console
          console.error("ban_user xui disable failed", {
            adminTelegramId: params.adminTelegramId,
            targetTelegramId: params.targetTelegramId,
            inboundId: xuiInboundId,
            uuid: xuiClientUuid,
            errorName: e2?.name,
            errorMessage: e2?.message,
          });
          xuiResult = { attempted: true, method: "disable", ok: false, errorName: e2?.name, errorMessage: e2?.message } as const;
        }
      }
    }

    // eslint-disable-next-line no-console
    console.info("ban_user banned", {
      adminTelegramId: params.adminTelegramId,
      targetTelegramId: params.targetTelegramId,
      blockedAlready,
      deletedFromDb,
      xui: xuiResult,
      reason,
      at: startedAt.toISOString(),
    });

    return { status: "banned", targetTelegramId: params.targetTelegramId, blockedAlready, deletedFromDb, xui: xuiResult, ...(reason ? { reason } : {}) };
  }

  async unbanUserByTelegramId(params: { adminTelegramId: string; targetTelegramId: string }): Promise<Readonly<{ status: "unbanned"; removed: boolean }>> {
    const telegramIdBig = this.parseTelegramIdToBigInt(params.targetTelegramId);
    const removed = await this.prisma.blockedUser.deleteMany({ where: { telegramId: telegramIdBig } });
    // eslint-disable-next-line no-console
    console.info("unban_user", { adminTelegramId: params.adminTelegramId, targetTelegramId: params.targetTelegramId, removed: removed.count });
    return { status: "unbanned", removed: removed.count > 0 };
  }
}
