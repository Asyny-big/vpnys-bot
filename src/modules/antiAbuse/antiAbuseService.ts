import type { Prisma, PrismaClient } from "@prisma/client";

export type AntiAbuseFlags = Readonly<{
  hadTrial: boolean;
  hadReferralBonus: boolean;
}>;

function parseTelegramIdToBigInt(telegramId: string): bigint {
  const trimmed = telegramId.trim();
  if (!/^\d{1,20}$/.test(trimmed)) throw new Error(`Invalid telegramId: ${telegramId}`);
  return BigInt(trimmed);
}

type PrismaTx = Prisma.TransactionClient;

export class AntiAbuseService {
  constructor(private readonly prisma: PrismaClient) {}

  async getOrCreateFlags(telegramId: string): Promise<AntiAbuseFlags> {
    const telegramIdBig = parseTelegramIdToBigInt(telegramId);
    const row = await this.prisma.antiAbuseRegistry.upsert({
      where: { telegramId: telegramIdBig },
      create: { telegramId: telegramIdBig, hadTrial: false, hadReferralBonus: false },
      update: {},
      select: { hadTrial: true, hadReferralBonus: true },
    });
    return { hadTrial: row.hadTrial, hadReferralBonus: row.hadReferralBonus };
  }

  async markTrialGranted(telegramId: string): Promise<void> {
    const telegramIdBig = parseTelegramIdToBigInt(telegramId);
    await this.prisma.antiAbuseRegistry.upsert({
      where: { telegramId: telegramIdBig },
      create: { telegramId: telegramIdBig, hadTrial: true, hadReferralBonus: false },
      update: { hadTrial: true },
    });
  }

  async markTrialGrantedTx(tx: PrismaTx, telegramId: string): Promise<void> {
    const telegramIdBig = parseTelegramIdToBigInt(telegramId);
    await tx.antiAbuseRegistry.upsert({
      where: { telegramId: telegramIdBig },
      create: { telegramId: telegramIdBig, hadTrial: true, hadReferralBonus: false },
      update: { hadTrial: true },
    });
  }

  async markReferralBonusGrantedTx(tx: PrismaTx, telegramId: string): Promise<void> {
    const telegramIdBig = parseTelegramIdToBigInt(telegramId);
    await tx.antiAbuseRegistry.upsert({
      where: { telegramId: telegramIdBig },
      create: { telegramId: telegramIdBig, hadTrial: false, hadReferralBonus: true },
      update: { hadReferralBonus: true },
    });
  }

  async markReferralBonusGranted(telegramId: string): Promise<void> {
    const telegramIdBig = parseTelegramIdToBigInt(telegramId);
    await this.prisma.antiAbuseRegistry.upsert({
      where: { telegramId: telegramIdBig },
      create: { telegramId: telegramIdBig, hadTrial: false, hadReferralBonus: true },
      update: { hadReferralBonus: true },
    });
  }
}
