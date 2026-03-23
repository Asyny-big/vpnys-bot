import type { DeviceConfig, Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { ThreeXUiService } from "../../integrations/threeXui/threeXuiService";
import { normalizeDeviceModel, type DeviceInfo } from "../../utils/deviceDetect";

export interface DeviceLimits {
  baseLimit: number;
  extraSlots: number;
  totalLimit: number;
  currentDevices: number;
  availableSlots: number;
}

export type DeviceMatchStrategy = "exact" | "candidate" | "heuristic" | "created" | "limit_reached";

export interface RegisterDeviceResult {
  success: boolean;
  device?: DeviceConfig;
  error?: string;
  errorCode?: "LIMIT_REACHED" | "SUBSCRIPTION_EXPIRED" | "UNKNOWN";
  matchStrategy?: DeviceMatchStrategy;
  collapsedDuplicates?: number;
  matchedDeviceId?: string;
  currentDevices?: number;
  totalLimit?: number;
}

export class DeviceService {
  private readonly registrationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly xui?: ThreeXUiService,
    private readonly xuiInboundId?: number,
  ) { }

  async getDeviceLimits(userId: string): Promise<DeviceLimits> {
    let subscription: { deviceLimit: number } | null = null;
    try {
      subscription = await this.prisma.subscription.findUnique({
        where: { userId },
        select: { deviceLimit: true },
      });
    } catch {
      // Ignore migration mismatches in older environments.
    }

    let currentDevices = 0;
    try {
      currentDevices = await this.prisma.deviceConfig.count({
        where: { userId },
      });
    } catch {
      // Ignore migration mismatches in older environments.
    }

    const totalLimit = subscription?.deviceLimit ?? 1;
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

  async registerDevice(
    userId: string,
    deviceInfo: DeviceInfo,
    subscriptionActive: boolean,
  ): Promise<RegisterDeviceResult> {
    if (!subscriptionActive) {
      await this.withUserLock(userId, async () => {
        await this.clearAllDevices(userId);
      });

      return {
        success: false,
        error: "РџРѕРґРїРёСЃРєР° РёСЃС‚РµРєР»Р°. РџСЂРѕРґР»РёС‚Рµ РїРѕРґРїРёСЃРєСѓ РґР»СЏ РїРѕРґРєР»СЋС‡РµРЅРёСЏ СѓСЃС‚СЂРѕР№СЃС‚РІР°.",
        errorCode: "SUBSCRIPTION_EXPIRED",
      };
    }

    return await this.withUserLock(userId, async () => {
      const fingerprintCandidates = this.getFingerprintCandidates(deviceInfo);
      const now = new Date();

      return await this.prisma.$transaction(async (tx) => {
        const devices = await this.listDevicesTx(tx, userId);
        const subscription = await tx.subscription.findUnique({
          where: { userId },
          select: { deviceLimit: true },
        });
        const totalLimit = subscription?.deviceLimit ?? 1;
        const currentDevices = devices.length;

        const fingerprintMatch = this.findFingerprintMatch(devices, fingerprintCandidates, deviceInfo.fingerprint);
        if (fingerprintMatch) {
          const updated = await this.touchExistingDevice(tx, fingerprintMatch.device, deviceInfo, now);
          const collapsedDuplicates = await this.collapseDuplicateDevices(tx, updated, devices, deviceInfo);
          return {
            success: true,
            device: updated,
            matchStrategy: fingerprintMatch.strategy,
            collapsedDuplicates,
            matchedDeviceId: updated.id,
            currentDevices,
            totalLimit,
          };
        }

        if (currentDevices >= totalLimit) {
          const heuristicMatch = this.findHeuristicMatch(devices, deviceInfo, totalLimit);
          if (heuristicMatch) {
            const updated = await this.touchExistingDevice(tx, heuristicMatch, deviceInfo, now);
            const collapsedDuplicates = await this.collapseDuplicateDevices(tx, updated, devices, deviceInfo);
            return {
              success: true,
              device: updated,
              matchStrategy: "heuristic",
              collapsedDuplicates,
              matchedDeviceId: updated.id,
              currentDevices,
              totalLimit,
            };
          }

          return {
            success: false,
            error: `Р”РѕСЃС‚РёРіРЅСѓС‚ Р»РёРјРёС‚ СѓСЃС‚СЂРѕР№СЃС‚РІ (${totalLimit}). РЈРґР°Р»РёС‚Рµ СЃС‚Р°СЂРѕРµ СѓСЃС‚СЂРѕР№СЃС‚РІРѕ РёР»Рё РєСѓРїРёС‚Рµ РґРѕРїРѕР»РЅРёС‚РµР»СЊРЅС‹Р№ СЃР»РѕС‚.`,
            errorCode: "LIMIT_REACHED",
            matchStrategy: "limit_reached",
            collapsedDuplicates: 0,
            currentDevices,
            totalLimit,
          };
        }

        const created = await this.createDeviceRecord(tx, userId, deviceInfo, now, currentDevices + 1, totalLimit);
        return {
          success: true,
          device: created.device,
          matchStrategy: created.strategy,
          collapsedDuplicates: 0,
          matchedDeviceId: created.device.id,
          currentDevices: created.strategy === "created" ? currentDevices + 1 : currentDevices,
          totalLimit,
        };
      });
    });
  }

  async listDevices(userId: string): Promise<DeviceConfig[]> {
    return await this.prisma.deviceConfig.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
    });
  }

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

  async renameDevice(userId: string, deviceId: string, newName: string): Promise<boolean> {
    try {
      const existing = await this.prisma.deviceConfig.findFirst({
        where: { id: deviceId, userId },
        select: { id: true },
      });
      if (!existing) {
        return false;
      }

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

  async createDeviceSlot(
    userId: string,
    deviceName: string,
    deviceInfo: DeviceInfo,
  ): Promise<{ success: boolean; device?: DeviceConfig; error?: string; errorCode?: string }> {
    const limits = await this.getDeviceLimits(userId);

    if (limits.availableSlots <= 0) {
      return {
        success: false,
        error: `Р”РѕСЃС‚РёРіРЅСѓС‚ Р»РёРјРёС‚ СѓСЃС‚СЂРѕР№СЃС‚РІ (${limits.totalLimit}). РЈРґР°Р»РёС‚Рµ СЃС‚Р°СЂРѕРµ СѓСЃС‚СЂРѕР№СЃС‚РІРѕ РёР»Рё РєСѓРїРёС‚Рµ РґРѕРїРѕР»РЅРёС‚РµР»СЊРЅС‹Р№ СЃР»РѕС‚.`,
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
        error: "РћС€РёР±РєР° СЃРѕР·РґР°РЅРёСЏ СѓСЃС‚СЂРѕР№СЃС‚РІР°",
        errorCode: "UNKNOWN",
      };
    }
  }

  private async withUserLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.registrationLocks.get(userId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.registrationLocks.set(userId, next);

    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      releaseCurrent();
      if (this.registrationLocks.get(userId) === next) {
        this.registrationLocks.delete(userId);
      }
    }
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

  private async listDevicesTx(tx: Prisma.TransactionClient, userId: string): Promise<DeviceConfig[]> {
    return await tx.deviceConfig.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
    });
  }

  private findFingerprintMatch(
    devices: DeviceConfig[],
    fingerprintCandidates: string[],
    canonicalFingerprint: string,
  ): { device: DeviceConfig; strategy: Extract<DeviceMatchStrategy, "exact" | "candidate"> } | null {
    const exactMatch = devices.find((device) => device.fingerprint === canonicalFingerprint);
    if (exactMatch) {
      return { device: exactMatch, strategy: "exact" };
    }

    const candidateSet = new Set(fingerprintCandidates);
    const candidateMatch = devices.find((device) => candidateSet.has(device.fingerprint));
    if (candidateMatch) {
      return { device: candidateMatch, strategy: "candidate" };
    }

    return null;
  }

  private findHeuristicMatch(
    devices: DeviceConfig[],
    deviceInfo: DeviceInfo,
    totalLimit: number,
  ): DeviceConfig | null {
    const samePlatform = devices.filter((device) => device.platform === deviceInfo.platform);
    if (samePlatform.length === 0) {
      return null;
    }

    if (deviceInfo.normalizedModel) {
      const sameModel = samePlatform.filter(
        (device) => normalizeDeviceModel(device.model) === deviceInfo.normalizedModel,
      );
      if (sameModel.length > 0) {
        return sameModel[0] ?? null;
      }
    }

    if (totalLimit === 1 && samePlatform.length === 1) {
      const onlyDevice = samePlatform[0];
      const existingNormalizedModel = normalizeDeviceModel(onlyDevice.model);
      if (!deviceInfo.normalizedModel || !existingNormalizedModel) {
        return onlyDevice;
      }
    }

    return null;
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

  private async collapseDuplicateDevices(
    tx: Prisma.TransactionClient,
    retainedDevice: DeviceConfig,
    devices: DeviceConfig[],
    deviceInfo: DeviceInfo,
  ): Promise<number> {
    const normalizedModel = deviceInfo.normalizedModel ?? normalizeDeviceModel(retainedDevice.model);
    if (!normalizedModel) {
      return 0;
    }

    const duplicateIds = devices
      .filter((device) =>
        device.id !== retainedDevice.id &&
        device.clientId == null &&
        device.platform === retainedDevice.platform &&
        normalizeDeviceModel(device.model) === normalizedModel,
      )
      .map((device) => device.id);

    if (duplicateIds.length === 0) {
      return 0;
    }

    const result = await tx.deviceConfig.deleteMany({
      where: {
        userId: retainedDevice.userId,
        id: { in: duplicateIds },
      },
    });

    return result.count;
  }

  private async createDeviceRecord(
    tx: Prisma.TransactionClient,
    userId: string,
    deviceInfo: DeviceInfo,
    now: Date,
    deviceNumber: number,
    totalLimit: number,
  ): Promise<{ device: DeviceConfig; strategy: Extract<DeviceMatchStrategy, "created" | "exact" | "candidate"> }> {
    const deviceName = this.generateDeviceName(deviceInfo, deviceNumber, totalLimit);

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
      return { device, strategy: "created" };
    } catch (err: any) {
      if (err?.code === "P2002") {
        const rereadDevices = await this.listDevicesTx(tx, userId);
        const rereadMatch = this.findFingerprintMatch(
          rereadDevices,
          this.getFingerprintCandidates(deviceInfo),
          deviceInfo.fingerprint,
        );

        if (rereadMatch) {
          const device = await this.touchExistingDevice(tx, rereadMatch.device, deviceInfo, now);
          return { device, strategy: rereadMatch.strategy };
        }
      }

      throw err;
    }
  }

  private generateDeviceName(deviceInfo: DeviceInfo, deviceNumber: number, totalLimit: number): string {
    if (deviceInfo.model && deviceInfo.model !== "iPhone" && deviceInfo.model !== "iPad") {
      return deviceInfo.model;
    }

    if (totalLimit <= 1) {
      return deviceInfo.platform;
    }

    return `${deviceInfo.platform} #${deviceNumber}`;
  }
}
