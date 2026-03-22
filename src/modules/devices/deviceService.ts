import type { PrismaClient, DeviceConfig, Prisma } from "@prisma/client";
import type { DeviceInfo } from "../../utils/deviceDetect";
import type { ThreeXUiService } from "../../integrations/threeXui/threeXuiService";
import { randomUUID } from "node:crypto";

export interface DeviceLimits {
  /** Base limit (always 1 for all plans) */
  baseLimit: number;
  /** Extra slots purchased by user */
  extraSlots: number;
  /** Total allowed devices */
  totalLimit: number;
  /** Currently registered devices */
  currentDevices: number;
  /** Available slots */
  availableSlots: number;
}

export interface RegisterDeviceResult {
  success: boolean;
  device?: DeviceConfig;
  error?: string;
  errorCode?: "LIMIT_REACHED" | "SUBSCRIPTION_EXPIRED" | "UNKNOWN";
}

export class DeviceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly xui?: ThreeXUiService,
    private readonly xuiInboundId?: number,
  ) { }

  /**
   * Calculate device limits for a user.
   * Source of truth: subscription.deviceLimit (обновляется через /addslot и покупки)
   */
  async getDeviceLimits(userId: string): Promise<DeviceLimits> {
    // Читаем актуальный лимит из подписки (source of truth)
    let subscription: { deviceLimit: number } | null = null;
    try {
      subscription = await this.prisma.subscription.findUnique({
        where: { userId },
        select: { deviceLimit: true },
      });
    } catch {
      // Ignore error (e.g. column not found)
    }

    // Считаем текущее количество устройств
    let currentDevices = 0;
    try {
      currentDevices = await this.prisma.deviceConfig.count({
        where: { userId },
      });
    } catch {
      // Ignore error (e.g. table not found)
    }

    // deviceLimit из подписки - это source of truth
    // Если подписки нет, используем базовый лимит 1
    const totalLimit = subscription?.deviceLimit ?? 1;

    // extraSlots вычисляем как разницу от базового лимита (для отображения)
    const baseLimit = 1;
    const extraSlots = Math.max(0, totalLimit - baseLimit);

    return {
      baseLimit,
      extraSlots,
      totalLimit,
      currentDevices,
      availableSlots: Math.max(0, totalLimit - currentDevices),
    };
  }

  /**
   * Автоматическая регистрация устройства при первом подключении.
   *
   * Логика:
   * 1. Если устройство уже существует (по fingerprint) -> обновить lastSeenAt, разрешить
   * 2. Если новое устройство и есть свободный слот -> создать, разрешить
   * 3. Если новое устройство и слота нет -> отказать (LIMIT_REACHED)
   *
   * Важно: lookup идет по каноническому fingerprint и по legacy aliases.
   * Source of truth — БД.
   */
  async registerDevice(
    userId: string,
    deviceInfo: DeviceInfo,
    subscriptionActive: boolean,
  ): Promise<RegisterDeviceResult> {
    if (!subscriptionActive) {
      await this.clearAllDevices(userId);

      return {
        success: false,
        error: "Подписка истекла. Продлите подписку для подключения устройства.",
        errorCode: "SUBSCRIPTION_EXPIRED",
      };
    }

    const fingerprintCandidates = this.getFingerprintCandidates(deviceInfo);
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      const existing = await tx.deviceConfig.findFirst({
        where: {
          userId,
          fingerprint: { in: fingerprintCandidates },
        },
        orderBy: { lastSeenAt: "desc" },
      });

      if (existing) {
        const updated = await this.touchExistingDevice(tx, existing, deviceInfo, now);
        return { success: true, device: updated };
      }

      const subscription = await tx.subscription.findUnique({
        where: { userId },
        select: { deviceLimit: true },
      });
      const totalLimit = subscription?.deviceLimit ?? 1;
      const currentDevices = await tx.deviceConfig.count({
        where: { userId },
      });

      if (currentDevices >= totalLimit) {
        return {
          success: false,
          error: `Достигнут лимит устройств (${totalLimit}). Удалите старое устройство или купите дополнительный слот.`,
          errorCode: "LIMIT_REACHED",
        };
      }

      const deviceName = this.generateDeviceName(deviceInfo, currentDevices + 1);

      try {
        const device = await tx.deviceConfig.create({
          data: {
            userId,
            fingerprint: deviceInfo.fingerprint,
            deviceName,
            platform: deviceInfo.platform,
            model: deviceInfo.model,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        });

        return { success: true, device };
      } catch (err: any) {
        if (err?.code === "P2002") {
          const reread = await tx.deviceConfig.findFirst({
            where: {
              userId,
              fingerprint: { in: fingerprintCandidates },
            },
            orderBy: { lastSeenAt: "desc" },
          });

          if (reread) {
            const updated = await this.touchExistingDevice(tx, reread, deviceInfo, now);
            return { success: true, device: updated };
          }
        }

        throw err;
      }
    });
  }

  private getFingerprintCandidates(deviceInfo: DeviceInfo): string[] {
    return Array.from(
      new Set(
        [deviceInfo.fingerprint, ...(deviceInfo.fingerprintCandidates ?? [])]
          .map((value) => value?.trim() ?? "")
          .filter((value) => value.length > 0),
      ),
    );
  }

  private async touchExistingDevice(
    tx: Prisma.TransactionClient,
    existing: DeviceConfig,
    deviceInfo: DeviceInfo,
    now: Date,
  ): Promise<DeviceConfig> {
    const data: Prisma.DeviceConfigUpdateInput = {
      lastSeenAt: now,
      platform: deviceInfo.platform,
    };

    if (deviceInfo.model) {
      data.model = deviceInfo.model;
    }

    if (existing.fingerprint !== deviceInfo.fingerprint) {
      data.fingerprint = deviceInfo.fingerprint;
    }

    try {
      return await tx.deviceConfig.update({
        where: { id: existing.id },
        data,
      });
    } catch (err: any) {
      if (err?.code === "P2002" && existing.fingerprint !== deviceInfo.fingerprint) {
        return await tx.deviceConfig.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: now,
            platform: deviceInfo.platform,
            ...(deviceInfo.model ? { model: deviceInfo.model } : {}),
          },
        });
      }

      throw err;
    }
  }

  /**
   * Generate human-readable device name.
   */
  private generateDeviceName(deviceInfo: DeviceInfo, deviceNumber: number): string {
    const platformEmoji: Record<string, string> = {
      Android: "рџ“±",
      iOS: "рџ“±",
      Windows: "рџ’»",
      macOS: "рџ’»",
      Linux: "рџђ§",
      Unknown: "рџ”§",
    };

    const emoji = platformEmoji[deviceInfo.platform] ?? "рџ”§";

    // If we have a real model name, use it
    if (deviceInfo.model && deviceInfo.model !== "iPhone" && deviceInfo.model !== "iPad") {
      return `${emoji} ${deviceInfo.model}`;
    }

    // Otherwise, generic name with number
    return `${emoji} ${deviceInfo.platform} #${deviceNumber}`;
  }

  /**
   * List all devices for a user.
   */
  async listDevices(userId: string): Promise<DeviceConfig[]> {
    return await this.prisma.deviceConfig.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
    });
  }

  /**
   * Remove a device.
   * Удаляет устройство из БД и соответствующий client из 3x-ui.
   */
  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    try {
      const device = await this.prisma.deviceConfig.findFirst({
        where: { id: deviceId, userId },
      });

      if (!device) {
        return false;
      }

      await this.prisma.deviceConfig.delete({
        where: { id: deviceId },
      });

      if (device.clientId && this.xui && this.xuiInboundId !== undefined) {
        try {
          await this.xui.deleteClient(this.xuiInboundId, device.clientId);
        } catch (err) {
          console.error(`Failed to delete client ${device.clientId} from 3x-ui:`, err);
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rename a device.
   */
  async renameDevice(userId: string, deviceId: string, newName: string): Promise<boolean> {
    try {
      const existing = await this.prisma.deviceConfig.findFirst({
        where: { id: deviceId, userId },
        select: { id: true },
      });
      if (!existing) return false;

      await this.prisma.deviceConfig.update({
        where: { id: existing.id },
        data: {
          deviceName: newName.trim().slice(0, 100),
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all devices for a user (called when subscription expires).
   * Удаляет все устройства из БД и все clients из 3x-ui.
   */
  async clearAllDevices(userId: string): Promise<number> {
    const devices = await this.prisma.deviceConfig.findMany({
      where: { userId },
      select: { id: true, clientId: true },
    });

    const result = await this.prisma.deviceConfig.deleteMany({
      where: { userId },
    });

    if (this.xui && this.xuiInboundId !== undefined) {
      for (const device of devices) {
        if (device.clientId) {
          try {
            await this.xui.deleteClient(this.xuiInboundId, device.clientId);
          } catch (err) {
            console.error(`Failed to delete client ${device.clientId} from 3x-ui:`, err);
          }
        }
      }
    }

    return result.count;
  }

  /**
   * Add extra device slots to user (after payment).
   */
  async addDeviceSlots(userId: string, slots: number): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        extraDeviceSlots: {
          increment: slots,
        },
      },
    });
  }

  /**
   * Create a new device slot for user.
   * This is the ONLY way to add devices - explicit user action.
   */
  async createDeviceSlot(
    userId: string,
    deviceName: string,
    deviceInfo: DeviceInfo,
  ): Promise<{ success: boolean; device?: DeviceConfig; error?: string; errorCode?: string }> {
    const limits = await this.getDeviceLimits(userId);

    if (limits.availableSlots <= 0) {
      return {
        success: false,
        error: `Достигнут лимит устройств (${limits.totalLimit}). Удалите старое устройство или купите дополнительный слот.`,
        errorCode: "LIMIT_REACHED",
      };
    }

    const clientId = randomUUID();

    try {
      const device = await this.prisma.deviceConfig.create({
        data: {
          userId,
          fingerprint: deviceInfo.fingerprint,
          clientId,
          deviceName: deviceName.trim().slice(0, 100),
          platform: deviceInfo.platform,
          model: deviceInfo.model,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      });

      return { success: true, device };
    } catch {
      return {
        success: false,
        error: "Ошибка создания устройства",
        errorCode: "UNKNOWN",
      };
    }
  }
}
