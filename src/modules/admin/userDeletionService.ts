import type { Prisma, PrismaClient } from "@prisma/client";
import { ThreeXUiService } from "../../integrations/threeXui/threeXuiService";

export type XuiDeleteOutcome = Readonly<
  | { attempted: false }
  | { attempted: true; method: "delete"; ok: true; details?: string }
  | { attempted: true; method: "disable"; ok: true; details?: string }
  | { attempted: true; method: "delete"; ok: false; errorName?: string; errorMessage?: string; details?: string }
  | { attempted: true; method: "disable"; ok: false; errorName?: string; errorMessage?: string; details?: string }
>;

export type DeleteUserWithoutBanResult = Readonly<
  | {
      status: "deleted";
      userId: string;
      targetTelegramId: string;
      xui: XuiDeleteOutcome;
    }
  | { status: "not_found"; targetTelegramId: string }
>;

export class AdminUserDeletionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly xui: ThreeXUiService,
  ) {}

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

  private async deleteFromXui(params: {
    adminTelegramId: string;
    targetTelegramId: string;
    inboundId?: number;
    uuid?: string;
  }): Promise<XuiDeleteOutcome> {
    if (typeof params.inboundId === "number" && typeof params.uuid === "string" && params.uuid.length) {
      try {
        await this.xui.deleteClient(params.inboundId, params.uuid);
        return { attempted: true, method: "delete", ok: true, details: "by_uuid" } as const;
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error("delete_user xui delete failed", {
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
          console.error("delete_user xui disable failed", {
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
      console.error("delete_user xui scan failed", {
        adminTelegramId: params.adminTelegramId,
        targetTelegramId: params.targetTelegramId,
        errorName: e?.name,
        errorMessage: e?.message,
      });
      return { attempted: true, method: "delete", ok: false, errorName: e?.name, errorMessage: e?.message, details: "by_email" } as const;
    }
  }

  async deleteUserWithoutBan(params: { adminTelegramId: string; targetTelegramId: string }): Promise<DeleteUserWithoutBanResult> {
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

    const xuiResult = await this.deleteFromXui({
      adminTelegramId: params.adminTelegramId,
      targetTelegramId: params.targetTelegramId,
      inboundId: user.subscription?.xuiInboundId,
      uuid: user.subscription?.xuiClientUuid,
    });

    // Strict per spec: user must be removed from 3x-ui first (delete -> fallback disable).
    if (xuiResult.attempted && !xuiResult.ok) {
      throw new Error(`3x-ui cleanup failed (${xuiResult.method}): ${xuiResult.errorMessage ?? xuiResult.errorName ?? "unknown"}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await this.deleteUserDataInTransaction(tx, user.id);
    });

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
}
