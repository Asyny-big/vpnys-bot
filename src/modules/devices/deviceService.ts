import type { PrismaClient, DeviceConfig } from "@prisma/client";
import type { DeviceInfo } from "../../utils/deviceDetect";

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
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Calculate device limits for a user.
   */
  async getDeviceLimits(userId: string): Promise<DeviceLimits> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { extraDeviceSlots: true },
    });

    const currentDevices = await this.prisma.deviceConfig.count({
      where: { userId },
    });

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
   * Register or update a device for a user.
   * Returns existing device if fingerprint matches, or creates new one if slots available.
   * Clears all devices if subscription just expired (was active, now inactive).
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
   */
  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    try {
      await this.prisma.deviceConfig.delete({
        where: {
          id: deviceId,
          userId, // Ensure user owns this device
        },
      });
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
   */
  async clearAllDevices(userId: string): Promise<number> {
    const result = await this.prisma.deviceConfig.deleteMany({
      where: { userId },
    });
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
}
