import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceConfig, PrismaClient } from "@prisma/client";
import { parseUserAgent } from "../../utils/deviceDetect";
import { DeviceService } from "./deviceService";

class FakePrisma {
  private nextId = 1;
  private readonly subscriptions = new Map<string, { deviceLimit: number }>();
  private readonly devices = new Map<string, DeviceConfig>();

  readonly subscription = {
    findUnique: async (_args: any) => null as { deviceLimit: number } | null,
  };

  readonly deviceConfig = {
    count: async (_args: any) => 0,
    findMany: async (_args: any) => [] as unknown[],
    create: async (_args: any) => {
      throw new Error("Not implemented");
    },
    update: async (_args: any) => {
      throw new Error("Not implemented");
    },
    deleteMany: async (_args: any) => ({ count: 0 }),
  };

  readonly user = {
    update: async (_args: unknown) => ({ id: "user" }),
  };

  constructor() {
    this.subscription.findUnique = async (args: any) => {
      await this.tick();
      const userId = args?.where?.userId;
      const row = userId ? this.subscriptions.get(userId) ?? null : null;
      if (!row) {
        return null;
      }
      return { deviceLimit: row.deviceLimit };
    };

    this.deviceConfig.count = async (args: any) => {
      await this.tick();
      return this.filterDevices(args?.where).length;
    };

    this.deviceConfig.findMany = async (args: any) => {
      await this.tick();
      const rows = this.sortDevices(this.filterDevices(args?.where));
      if (!args?.select) {
        return rows.map((row) => this.cloneDevice(row));
      }
      return rows.map((row) => this.applySelect(row, args.select));
    };

    this.deviceConfig.create = async (args: any) => {
      await this.tick();
      const data = args.data;
      this.assertUniqueFingerprint(undefined, data.userId, data.fingerprint);
      this.assertUniqueClientId(undefined, data.clientId ?? null);

      const now = new Date();
      const record: DeviceConfig = {
        id: `device-${this.nextId++}`,
        userId: data.userId,
        fingerprint: data.fingerprint,
        clientId: data.clientId ?? null,
        deviceName: data.deviceName,
        platform: data.platform,
        model: data.model ?? null,
        firstSeenAt: data.firstSeenAt ?? now,
        lastSeenAt: data.lastSeenAt ?? now,
        createdAt: now,
        updatedAt: now,
      };
      this.devices.set(record.id, record);
      return this.cloneDevice(record);
    };

    this.deviceConfig.update = async (args: any) => {
      await this.tick();
      const existing = this.devices.get(args?.where?.id);
      if (!existing) {
        throw new Error(`Device not found: ${args?.where?.id ?? "unknown"}`);
      }

      const nextFingerprint = args.data?.fingerprint ?? existing.fingerprint;
      const nextClientId = args.data?.clientId ?? existing.clientId;
      this.assertUniqueFingerprint(existing.id, existing.userId, nextFingerprint);
      this.assertUniqueClientId(existing.id, nextClientId);

      const updated: DeviceConfig = {
        ...existing,
        fingerprint: nextFingerprint,
        clientId: nextClientId ?? null,
        deviceName: args.data?.deviceName ?? existing.deviceName,
        platform: args.data?.platform ?? existing.platform,
        model: args.data?.model ?? existing.model,
        firstSeenAt: args.data?.firstSeenAt ?? existing.firstSeenAt,
        lastSeenAt: args.data?.lastSeenAt ?? existing.lastSeenAt,
        updatedAt: new Date(),
      };
      this.devices.set(updated.id, updated);
      return this.cloneDevice(updated);
    };

    this.deviceConfig.deleteMany = async (args: any) => {
      await this.tick();
      const rows = this.filterDevices(args?.where);
      for (const row of rows) {
        this.devices.delete(row.id);
      }
      return { count: rows.length };
    };
  }

  async $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    await this.tick();
    return await callback(this);
  }

  seedSubscription(userId: string, deviceLimit: number): void {
    this.subscriptions.set(userId, { deviceLimit });
  }

  seedDevice(input: Partial<DeviceConfig> & Pick<DeviceConfig, "userId" | "fingerprint" | "deviceName" | "platform">): DeviceConfig {
    const now = input.lastSeenAt ?? new Date();
    const record: DeviceConfig = {
      id: input.id ?? `device-${this.nextId++}`,
      userId: input.userId,
      fingerprint: input.fingerprint,
      clientId: input.clientId ?? null,
      deviceName: input.deviceName,
      platform: input.platform,
      model: input.model ?? null,
      firstSeenAt: input.firstSeenAt ?? now,
      lastSeenAt: input.lastSeenAt ?? now,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.devices.set(record.id, record);
    return this.cloneDevice(record);
  }

  listDevices(userId: string): DeviceConfig[] {
    return this.sortDevices(Array.from(this.devices.values()).filter((device) => device.userId === userId))
      .map((device) => this.cloneDevice(device));
  }

  private filterDevices(where: any): DeviceConfig[] {
    let rows = Array.from(this.devices.values());

    if (where?.userId) {
      rows = rows.filter((row) => row.userId === where.userId);
    }

    if (where?.id) {
      if (typeof where.id === "string") {
        rows = rows.filter((row) => row.id === where.id);
      } else if (Array.isArray(where.id?.in)) {
        const idSet = new Set(where.id.in);
        rows = rows.filter((row) => idSet.has(row.id));
      }
    }

    if (where?.fingerprint?.in) {
      const fingerprintSet = new Set(where.fingerprint.in);
      rows = rows.filter((row) => fingerprintSet.has(row.fingerprint));
    }

    return rows;
  }

  private sortDevices(rows: DeviceConfig[]): DeviceConfig[] {
    return [...rows].sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime());
  }

  private applySelect(row: DeviceConfig, select: Record<string, boolean>): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const [key, enabled] of Object.entries(select)) {
      if (enabled) {
        picked[key] = (row as Record<string, unknown>)[key];
      }
    }
    return picked;
  }

  private assertUniqueFingerprint(existingId: string | undefined, userId: string, fingerprint: string): void {
    const collision = Array.from(this.devices.values()).find((device) =>
      device.userId === userId &&
      device.fingerprint === fingerprint &&
      device.id !== existingId,
    );
    if (collision) {
      const err = new Error("Unique fingerprint violation") as Error & { code?: string };
      err.code = "P2002";
      throw err;
    }
  }

  private assertUniqueClientId(existingId: string | undefined, clientId: string | null): void {
    if (!clientId) {
      return;
    }

    const collision = Array.from(this.devices.values()).find((device) =>
      device.clientId === clientId &&
      device.id !== existingId,
    );
    if (collision) {
      const err = new Error("Unique clientId violation") as Error & { code?: string };
      err.code = "P2002";
      throw err;
    }
  }

  private cloneDevice(device: DeviceConfig): DeviceConfig {
    return {
      ...device,
      firstSeenAt: new Date(device.firstSeenAt),
      lastSeenAt: new Date(device.lastSeenAt),
      createdAt: new Date(device.createdAt),
      updatedAt: new Date(device.updatedAt),
    };
  }

  private async tick(): Promise<void> {
    await Promise.resolve();
  }
}

function createService(limit = 1, userId = "user-1"): { prisma: FakePrisma; service: DeviceService; userId: string } {
  const prisma = new FakePrisma();
  prisma.seedSubscription(userId, limit);
  const service = new DeviceService(prisma as unknown as PrismaClient);
  return { prisma, service, userId };
}

test("reuses the same Android device across different user agents when model is stable", async () => {
  const { prisma, service, userId } = createService(1);
  const firstInfo = parseUserAgent("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36");
  const secondInfo = parseUserAgent("Mozilla/5.0 (Linux; Android 14; SM-G991B; wv) AppleWebKit/537.36 Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36");

  const first = await service.registerDevice(userId, firstInfo, true);
  const second = await service.registerDevice(userId, secondInfo, true);
  const devices = prisma.listDevices(userId);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(second.matchStrategy, "exact");
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.fingerprint, secondInfo.fingerprint);
});

test("migrates a legacy fingerprint to the new canonical Android model fingerprint", async () => {
  const { prisma, service, userId } = createService(1);
  const deviceInfo = parseUserAgent("Mozilla/5.0 (Linux; Android 13; Redmi Note 8 Pro) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36");
  const legacyFingerprint = deviceInfo.fingerprintCandidates[1];

  assert.ok(legacyFingerprint);
  assert.notEqual(deviceInfo.fingerprint, legacyFingerprint);

  prisma.seedDevice({
    userId,
    fingerprint: legacyFingerprint!,
    deviceName: "Legacy Android",
    platform: "Android",
    model: "Redmi Note 8 Pro",
  });

  const result = await service.registerDevice(userId, deviceInfo, true);
  const devices = prisma.listDevices(userId);

  assert.equal(result.success, true);
  assert.equal(result.matchStrategy, "candidate");
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.fingerprint, deviceInfo.fingerprint);
});

test("serializes same-user burst requests and keeps only one row for unknown-model Android drift", async () => {
  const { prisma, service, userId } = createService(1);
  const deviceInfos = [
    parseUserAgent("Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36"),
    parseUserAgent("Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36"),
    parseUserAgent("Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36"),
  ];

  const results = await Promise.all(deviceInfos.map((deviceInfo) => service.registerDevice(userId, deviceInfo, true)));
  const devices = prisma.listDevices(userId);

  assert.ok(results.every((result) => result.success));
  assert.equal(devices.length, 1);
});

test("reuses the only same-platform slot at limit 1 when model data is missing", async () => {
  const { prisma, service, userId } = createService(1);
  const originalInfo = parseUserAgent("Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36");
  const driftedInfo = parseUserAgent("Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36");

  prisma.seedDevice({
    userId,
    fingerprint: originalInfo.fingerprint,
    deviceName: "Android",
    platform: "Android",
    model: null,
  });

  const result = await service.registerDevice(userId, driftedInfo, true);
  const devices = prisma.listDevices(userId);

  assert.equal(result.success, true);
  assert.equal(result.matchStrategy, "heuristic");
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.fingerprint, driftedInfo.fingerprint);
});

test("keeps hard limit for a real new device when the known model changes", async () => {
  const { prisma, service, userId } = createService(1);
  const existingInfo = parseUserAgent("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36");
  const newDeviceInfo = parseUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36");

  prisma.seedDevice({
    userId,
    fingerprint: existingInfo.fingerprint,
    deviceName: "Samsung",
    platform: "Android",
    model: "SM-G991B",
  });

  const result = await service.registerDevice(userId, newDeviceInfo, true);
  const devices = prisma.listDevices(userId);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, "LIMIT_REACHED");
  assert.equal(result.matchStrategy, "limit_reached");
  assert.equal(devices.length, 1);
});

test("collapses only obvious null-clientId duplicates for the same known model", async () => {
  const { prisma, service, userId } = createService(3);
  const deviceInfo = parseUserAgent("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36");
  const aliasFingerprint = deviceInfo.fingerprintCandidates[1] ?? deviceInfo.fingerprint;

  prisma.seedDevice({
    id: "keep",
    userId,
    fingerprint: aliasFingerprint,
    deviceName: "Samsung main",
    platform: "Android",
    model: "SM-G991B",
    lastSeenAt: new Date("2026-03-20T10:00:00.000Z"),
  });
  prisma.seedDevice({
    id: "drop-null",
    userId,
    fingerprint: "old-duplicate",
    deviceName: "Samsung duplicate",
    platform: "Android",
    model: "SM-G991B",
    clientId: null,
    lastSeenAt: new Date("2026-03-19T10:00:00.000Z"),
  });
  prisma.seedDevice({
    id: "keep-client",
    userId,
    fingerprint: "keep-client-fp",
    deviceName: "Samsung client",
    platform: "Android",
    model: "SM-G991B",
    clientId: "xui-client-1",
    lastSeenAt: new Date("2026-03-18T10:00:00.000Z"),
  });
  prisma.seedDevice({
    id: "keep-other-model",
    userId,
    fingerprint: "other-model-fp",
    deviceName: "Pixel",
    platform: "Android",
    model: "Pixel 8",
    lastSeenAt: new Date("2026-03-17T10:00:00.000Z"),
  });

  const result = await service.registerDevice(userId, deviceInfo, true);
  const devices = prisma.listDevices(userId);

  assert.equal(result.success, true);
  assert.equal(result.collapsedDuplicates, 1);
  assert.equal(devices.length, 3);
  assert.ok(devices.some((device) => device.id === "keep"));
  assert.ok(devices.some((device) => device.id === "keep-client"));
  assert.ok(devices.some((device) => device.id === "keep-other-model"));
  assert.ok(!devices.some((device) => device.id === "drop-null"));
});
