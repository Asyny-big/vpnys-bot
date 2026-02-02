import type { PrismaClient, DeviceConfig } from "@prisma/client";
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
   */
  async getDeviceLimits(userId: string): Promise<DeviceLimits> {
    let user: { extraDeviceSlots: number } | null = null;
    try {
      user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { extraDeviceSlots: true },
      });
    } catch {
      // Ignore error (e.g. column not found) and use default limits
    }

    // Ensure we don't crash on count if table doesn't exist
    let currentDevices = 0;
    try {
      currentDevices = await this.prisma.deviceConfig.count({
        where: { userId },
      });
    } catch {
      // Ignore error (e.g. table not found)
    }

    const baseLimit = 1;
    const extraSlots = user?.extraDeviceSlots ?? 0;
    const totalLimit = baseLimit + extraSlots;

    return {
      baseLimit,
      extraSlots,
      totalLimit,
      currentDevices,
      availableSlots: Math.max(0, totalLimit - currentDevices),
    };
  }

  /**
   * @deprecated Не использовать для автоматической регистрации при подключении!
   * 
   * Register or update a device for a user.
   * Returns existing device if fingerprint matches, or creates new one if slots available.
   * Clears all devices if subscription just expired (was active, now inactive).
   * 
   * ⚠️ ВАЖНО: Этот метод НЕ должен вызываться при подключении VPN.
   * Устройства создаются ТОЛЬКО через явное действие "Добавить устройство".
   */
  async registerDevice(
    userId: string,
    deviceInfo: DeviceInfo,
    subscriptionActive: boolean,
  ): Promise<RegisterDeviceResult> {
    // Check if subscription is active
    if (!subscriptionActive) {
      // Clear all devices when subscription expires
      await this.clearAllDevices(userId);

      return {
        success: false,
        error: "Подписка истекла. Продлите подписку для подключения устройств.",
        errorCode: "SUBSCRIPTION_EXPIRED",
      };
    }

    // Check if device already registered (by fingerprint)
    const existing = await this.prisma.deviceConfig.findUnique({
      where: {
        userId_fingerprint: {
          userId,
          fingerprint: deviceInfo.fingerprint,
        },
      },
    });

    if (existing) {
      // Update lastSeenAt
      const updated = await this.prisma.deviceConfig.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });

      return { success: true, device: updated };
    }

    // Check device limits
    const limits = await this.getDeviceLimits(userId);

    if (limits.availableSlots <= 0) {
      return {
        success: false,
        error: `Достигнут лимит устройств (${limits.totalLimit}). Удалите старое устройство или купите дополнительный слот.`,
        errorCode: "LIMIT_REACHED",
      };
    }

    // Generate device name
    const deviceName = this.generateDeviceName(deviceInfo, limits.currentDevices + 1);

    // Create new device
    const device = await this.prisma.deviceConfig.create({
      data: {
        userId,
        fingerprint: deviceInfo.fingerprint,
        deviceName,
        platform: deviceInfo.platform,
        model: deviceInfo.model,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    return { success: true, device };
  }

  /**
   * Generate human-readable device name.
   */
  private generateDeviceName(deviceInfo: DeviceInfo, deviceNumber: number): string {
    const platformEmoji: Record<string, string> = {
      Android: "📱",
      iOS: "📱",
      Windows: "💻",
      macOS: "💻",
      Linux: "🐧",
      Unknown: "🔧",
    };

    const emoji = platformEmoji[deviceInfo.platform] ?? "🔧";
    const model = deviceInfo.model ?? deviceInfo.platform;

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
   * ✅ ИСПРАВЛЕНО: Удаляет устройство из БД И соответствующий client из 3x-ui.
   */
  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    try {
      // Получить clientId перед удалением
      const device = await this.prisma.deviceConfig.findUnique({
        where: { id: deviceId, userId },
      });

      if (!device) {
        return false;
      }

      // Удалить из БД (source of truth)
      await this.prisma.deviceConfig.delete({
        where: {
          id: deviceId,
          userId, // Ensure user owns this device
        },
      });

      // Удалить client из 3x-ui (если есть clientId и настроена интеграция)
      if (device.clientId && this.xui && this.xuiInboundId !== undefined) {
        try {
          await this.xui.deleteClient(this.xuiInboundId, device.clientId);
        } catch (err) {
          // Логируем, но не падаем - БД уже обновлена (source of truth)
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
      await this.prisma.deviceConfig.update({
        where: {
          id: deviceId,
          userId,
        },
        data: {
          deviceName: newName.trim().slice(0, 100), // Limit length
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all devices for a user (called when subscription expires).
   * ✅ ИСПРАВЛЕНО: Удаляет все устройства из БД И все clients из 3x-ui.
   */
  async clearAllDevices(userId: string): Promise<number> {
    // Получить все устройства с clientId
    const devices = await this.prisma.deviceConfig.findMany({
      where: { userId },
      select: { id: true, clientId: true },
    });

    // Удалить из БД (source of truth)
    const result = await this.prisma.deviceConfig.deleteMany({
      where: { userId },
    });

    // Удалить все clients из 3x-ui
    if (this.xui && this.xuiInboundId !== undefined) {
      for (const device of devices) {
        if (device.clientId) {
          try {
            await this.xui.deleteClient(this.xuiInboundId, device.clientId);
          } catch (err) {
            // Логируем, но продолжаем - БД уже обновлена
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
   * 
   * ✅ Правильный flow:
   * 1. Пользователь нажимает "Добавить устройство"
   * 2. Генерируется уникальный clientId (UUID)
   * 3. Создается запись в БД
   * 4. Создается соответствующий client в 3x-ui
   * 5. Пользователь получает ссылку для подключения этого конкретного устройства
   */
  async createDeviceSlot(
    userId: string,
    deviceName: string,
    deviceInfo: DeviceInfo,
  ): Promise<{ success: boolean; device?: DeviceConfig; error?: string; errorCode?: string }> {
    // Check device limits
    const limits = await this.getDeviceLimits(userId);

    if (limits.availableSlots <= 0) {
      return {
        success: false,
        error: `Достигнут лимит устройств (${limits.totalLimit}). Удалите старое устройство или купите дополнительный слот.`,
        errorCode: "LIMIT_REACHED",
      };
    }

    // Generate unique clientId for this device (VLESS client UUID)
    const clientId = randomUUID();

    // Create device in DB
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
    } catch (err: any) {
      return {
        success: false,
        error: "Ошибка создания устройства",
        errorCode: "UNKNOWN",
      };
    }
  }
}
