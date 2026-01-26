import { randomBytes, randomUUID } from "node:crypto";
import { ThreeXUiApiClient, ThreeXUiError } from "./threeXuiApiClient";
import { clampDeviceLimit } from "../../domain/deviceLimits";

type Inbound = Readonly<{
  id: number;
  settings: string; // JSON string, contains clients array
}>;

type InboundGetResponse = Readonly<{
  id: number;
  settings: string;
}>;

export type ThreeXUiClientInfo = Readonly<{
  uuid: string;
  subscriptionId: string;
  email: string;
  expiresAt?: Date;
  enabled: boolean;
  limitIp?: number;
}>;

export type VlessRealityTemplate = Readonly<{
  protocol: "vless";
  port: number;
  network: "tcp" | "ws" | "grpc";
  security: "reality";
  sni: string;
  publicKey: string;
  shortId?: string;
  spiderX?: string;
  fingerprint?: string;
  alpn?: string;
  tcpHeaderType?: string;
  wsPath?: string;
  wsHost?: string;
  grpcServiceName?: string;
}>;

export class ThreeXUiService {
  constructor(private readonly api: ThreeXUiApiClient) {}

  private readonly vlessRealityTemplateCache = new Map<number, { fetchedAt: number; value: VlessRealityTemplate }>();
  private readonly vlessRealityTemplateTtlMs = 10 * 60 * 1000;

  telegramEmail(telegramId: string): string {
    return `tg:${telegramId}`;
  }

  async listInbounds(): Promise<Inbound[]> {
    return await this.api.requestJson<Inbound[]>("/panel/api/inbounds/list", { method: "GET" });
  }

  private parseJsonMaybe(value: unknown): any {
    if (!value) return null;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  async getVlessRealityTemplate(inboundId: number): Promise<VlessRealityTemplate> {
    const cached = this.vlessRealityTemplateCache.get(inboundId);
    if (cached && Date.now() - cached.fetchedAt < this.vlessRealityTemplateTtlMs) return cached.value;

    const inbound = await this.api.requestJson<any>(`/panel/api/inbounds/get/${inboundId}`, { method: "GET" });
    const port = Number(inbound?.port);
    if (!Number.isFinite(port) || port <= 0) {
      throw new ThreeXUiError(`3x-ui inbound ${inboundId} missing/invalid port`, { details: inbound });
    }

    const protocol = String(inbound?.protocol ?? "");
    if (protocol !== "vless") {
      throw new ThreeXUiError(`3x-ui inbound ${inboundId} protocol is not vless (got: ${protocol || "empty"})`, { details: inbound });
    }

    const stream = this.parseJsonMaybe(inbound?.streamSettings);
    const networkRaw = String(stream?.network ?? "tcp");
    const network =
      networkRaw === "tcp" || networkRaw === "ws" || networkRaw === "grpc"
        ? networkRaw
        : "tcp";

    const security = String(stream?.security ?? "");
    if (security !== "reality") {
      throw new ThreeXUiError(`3x-ui inbound ${inboundId} security is not reality (got: ${security || "empty"})`, { details: inbound });
    }

    const reality = stream?.realitySettings ?? stream?.reality ?? null;
    const realitySettings = (reality?.settings ?? reality?.Settings ?? null) as any;
    const publicKey = String(
      (reality?.publicKey ??
        reality?.public_key ??
        reality?.publickey ??
        reality?.pbk ??
        realitySettings?.publicKey ??
        realitySettings?.public_key ??
        realitySettings?.publickey ??
        realitySettings?.pbk ??
        "") as any,
    ).trim();
    if (!publicKey) {
      throw new ThreeXUiError(`3x-ui inbound ${inboundId} missing reality publicKey`, { details: inbound });
    }

    const serverNames =
      Array.isArray(reality?.serverNames)
        ? reality.serverNames
        : Array.isArray(reality?.server_names)
          ? reality.server_names
          : null;
    const sni = String(
      (serverNames?.[0] ??
        reality?.serverName ??
        reality?.server_name ??
        reality?.servername ??
        realitySettings?.serverName ??
        realitySettings?.server_name ??
        realitySettings?.servername ??
        "") as any,
    ).trim();
    if (!sni) {
      throw new ThreeXUiError(`3x-ui inbound ${inboundId} missing reality serverNames/serverName`, { details: inbound });
    }

    const shortIds =
      Array.isArray(reality?.shortIds)
        ? reality.shortIds
        : Array.isArray(reality?.short_ids)
          ? reality.short_ids
          : null;
    const shortIdRaw = (shortIds?.[0] ?? reality?.shortId ?? reality?.short_id ?? "") as any;
    const shortId = typeof shortIdRaw === "string" && shortIdRaw.trim().length ? shortIdRaw.trim() : undefined;

    const spiderXRaw = (reality?.spiderX ?? reality?.spider_x ?? realitySettings?.spiderX ?? realitySettings?.spider_x ?? "") as any;
    const spiderX = typeof spiderXRaw === "string" && spiderXRaw.trim().length ? spiderXRaw.trim() : undefined;

    const fpRaw = (reality?.fingerprint ?? realitySettings?.fingerprint ?? stream?.tlsSettings?.fingerprint ?? "") as any;
    const fingerprint = typeof fpRaw === "string" && fpRaw.trim().length ? fpRaw.trim() : undefined;

    const alpnList = Array.isArray(reality?.alpn) ? reality.alpn : Array.isArray(stream?.tlsSettings?.alpn) ? stream.tlsSettings.alpn : null;
    const alpn =
      alpnList && alpnList.map((v: any) => String(v ?? "").trim()).filter(Boolean).length
        ? alpnList.map((v: any) => String(v ?? "").trim()).filter(Boolean).join(",")
        : undefined;

    const tcpHeaderTypeRaw = (stream?.tcpSettings?.header?.type ?? "") as any;
    const tcpHeaderType =
      typeof tcpHeaderTypeRaw === "string" && tcpHeaderTypeRaw.trim().length
        ? tcpHeaderTypeRaw.trim()
        : undefined;

    const wsPathRaw = (stream?.wsSettings?.path ?? "") as any;
    const wsPath = typeof wsPathRaw === "string" && wsPathRaw.trim().length ? wsPathRaw.trim() : undefined;
    const wsHostRaw = (stream?.wsSettings?.headers?.Host ?? stream?.wsSettings?.headers?.host ?? "") as any;
    const wsHost = typeof wsHostRaw === "string" && wsHostRaw.trim().length ? wsHostRaw.trim() : undefined;

    const grpcServiceNameRaw = (stream?.grpcSettings?.serviceName ?? "") as any;
    const grpcServiceName =
      typeof grpcServiceNameRaw === "string" && grpcServiceNameRaw.trim().length
        ? grpcServiceNameRaw.trim()
        : undefined;

    const value: VlessRealityTemplate = {
      protocol: "vless",
      port,
      network,
      security: "reality",
      sni,
      publicKey,
      ...(shortId ? { shortId } : {}),
      ...(spiderX ? { spiderX } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(alpn ? { alpn } : {}),
      ...(tcpHeaderType ? { tcpHeaderType } : {}),
      ...(wsPath ? { wsPath } : {}),
      ...(wsHost ? { wsHost } : {}),
      ...(grpcServiceName ? { grpcServiceName } : {}),
    };

    this.vlessRealityTemplateCache.set(inboundId, { fetchedAt: Date.now(), value });
    return value;
  }

  private async getInboundMaybe(inboundId: number): Promise<Inbound | null> {
    // Some 3x-ui versions expose /get/<id>. Prefer it to avoid listing everything.
    try {
      const inbound = await this.api.requestJson<InboundGetResponse>(`/panel/api/inbounds/get/${inboundId}`, { method: "GET" });
      if (inbound?.id === inboundId && typeof inbound.settings === "string") return inbound;
      return null;
    } catch {
      return null;
    }
  }

  private parseClients(settingsJson: string): any[] {
    try {
      const parsed = JSON.parse(settingsJson);
      const clients = parsed?.clients;
      if (!Array.isArray(clients)) return [];
      return clients;
    } catch {
      return [];
    }
  }

  private async getInboundOrThrow(inboundId: number): Promise<Inbound> {
    const direct = await this.getInboundMaybe(inboundId);
    if (direct) return direct;
    const inbounds = await this.listInbounds();
    const inbound = inbounds.find((i) => i.id === inboundId);
    if (!inbound) throw new ThreeXUiError(`3x-ui inbound not found: ${inboundId}`);
    return inbound;
  }

  async listClients(inboundId: number): Promise<ThreeXUiClientInfo[]> {
    const inbound = await this.getInboundOrThrow(inboundId);
    const clients = this.parseClients(inbound.settings);
    return clients.map((client) => ({
      uuid: String(client.id),
      subscriptionId: String(client.subId ?? ""),
      email: String(client.email ?? ""),
      expiresAt: Number.isFinite(client.expiryTime) && client.expiryTime > 0 ? new Date(Number(client.expiryTime)) : undefined,
      enabled: client.enable !== false,
      limitIp: Number.isFinite(client.limitIp) ? Number(client.limitIp) : undefined,
    }));
  }

  private async getClientRawByUuid(inboundId: number, uuid: string): Promise<any | null> {
    const inbound = await this.getInboundOrThrow(inboundId);
    const clients = this.parseClients(inbound.settings);
    return clients.find((c) => String(c?.id) === uuid) ?? null;
  }

  async findClientByEmail(inboundId: number, email: string): Promise<ThreeXUiClientInfo | null> {
    const inbound = await this.getInboundOrThrow(inboundId);
    const clients = this.parseClients(inbound.settings);
    const client = clients.find((c) => typeof c?.email === "string" && c.email === email);
    if (!client) return null;

    return {
      uuid: String(client.id),
      subscriptionId: String(client.subId ?? ""),
      email: String(client.email),
      expiresAt: Number.isFinite(client.expiryTime) && client.expiryTime > 0 ? new Date(Number(client.expiryTime)) : undefined,
      enabled: client.enable !== false,
      limitIp: Number.isFinite(client.limitIp) ? Number(client.limitIp) : undefined,
    };
  }

  async findClientByUuid(inboundId: number, uuid: string): Promise<ThreeXUiClientInfo | null> {
    const inbound = await this.getInboundOrThrow(inboundId);
    const clients = this.parseClients(inbound.settings);
    const client = clients.find((c) => String(c?.id) === uuid);
    if (!client) return null;

    return {
      uuid: String(client.id),
      subscriptionId: String(client.subId ?? ""),
      email: String(client.email ?? ""),
      expiresAt: Number.isFinite(client.expiryTime) && client.expiryTime > 0 ? new Date(Number(client.expiryTime)) : undefined,
      enabled: client.enable !== false,
      limitIp: Number.isFinite(client.limitIp) ? Number(client.limitIp) : undefined,
    };
  }

  private buildClientPatch(input: {
    uuid: string;
    email: string;
    subscriptionId: string;
    expiresAt?: Date;
    enabled: boolean;
    deviceLimit: number;
    flow?: string;
  }): any {
    const expiryTime = input.expiresAt ? input.expiresAt.getTime() : 0;
    const limitIp = clampDeviceLimit(input.deviceLimit);
    const patch: any = {
      id: input.uuid,
      email: input.email,
      enable: input.enabled,
      expiryTime,
      subId: input.subscriptionId,
      limitIp,
    };
    if (input.flow) patch.flow = input.flow;
    return patch;
  }

  private static newSubscriptionId(): string {
    // 16 bytes -> 32 hex chars, URL-friendly.
    return randomBytes(16).toString("hex");
  }

  async ensureClient(params: {
    inboundId: number;
    telegramId: string;
    deviceLimit: number;
    flow?: string;
  }): Promise<ThreeXUiClientInfo> {
    const email = this.telegramEmail(params.telegramId);
    const existing = await this.findClientByEmail(params.inboundId, email);
    if (existing?.uuid && existing.subscriptionId) return existing;

    const uuid = randomUUID();
    const subId = ThreeXUiService.newSubscriptionId();

    await this.api.requestJson("/panel/api/inbounds/addClient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: params.inboundId,
        settings: JSON.stringify({
          clients: [this.buildClientPatch({ uuid, email, subscriptionId: subId, enabled: true, deviceLimit: params.deviceLimit, flow: params.flow })],
        }),
      }),
    });

    const created = await this.findClientByEmail(params.inboundId, email);
    if (!created) throw new ThreeXUiError("3x-ui client creation succeeded but client not found afterwards");
    if (!created.subscriptionId) {
      // Some versions might not persist subId in the client settings until update; enforce.
      await this.updateClient(params.inboundId, uuid, { subscriptionId: subId, deviceLimit: params.deviceLimit });
      const reread = await this.findClientByEmail(params.inboundId, email);
      if (!reread?.subscriptionId) throw new ThreeXUiError("3x-ui did not persist subscriptionId");
      return reread;
    }
    return created;
  }

  async updateClient(
    inboundId: number,
    uuid: string,
    patch: Partial<Pick<ThreeXUiClientInfo, "expiresAt" | "enabled" | "subscriptionId">> & { deviceLimit?: number },
  ): Promise<void> {
    const raw = await this.getClientRawByUuid(inboundId, uuid);
    if (!raw) throw new ThreeXUiError(`3x-ui client not found: ${uuid}`);

    // Preserve unknown fields (important for VLESS/Reality client fields like flow).
    const expiryTime =
      patch.expiresAt !== undefined
        ? (patch.expiresAt ? patch.expiresAt.getTime() : 0)
        : Number.isFinite(raw.expiryTime)
          ? Number(raw.expiryTime)
          : 0;

    const limitIp = clampDeviceLimit(
      patch.deviceLimit !== undefined
        ? patch.deviceLimit
        : Number.isFinite(raw.limitIp)
          ? Number(raw.limitIp)
          : 1,
    );

    const updatedClient = {
      ...raw,
      enable: patch.enabled ?? raw.enable ?? true,
      expiryTime,
      subId: patch.subscriptionId ?? raw.subId ?? "",
      // Enforce per-user device limit.
      limitIp,
    };

    // Primary endpoint used by most x-ui/3x-ui versions.
    const attempt = async (path: string): Promise<void> => {
      await this.api.requestJson(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: inboundId,
          settings: JSON.stringify({
            clients: [updatedClient],
          }),
        }),
      });
    };

    try {
      await attempt(`/panel/api/inbounds/updateClient/${encodeURIComponent(uuid)}`);
      return;
    } catch (e) {
      // Fallback for versions that accept /updateClient without path param.
      await attempt("/panel/api/inbounds/updateClient");
    }
  }

  async setExpiryAndEnable(params: {
    inboundId: number;
    uuid: string;
    subscriptionId: string;
    expiresAt: Date;
    enabled: boolean;
    deviceLimit: number;
  }): Promise<void> {
    await this.updateClient(params.inboundId, params.uuid, {
      expiresAt: params.expiresAt,
      enabled: params.enabled,
      subscriptionId: params.subscriptionId,
      deviceLimit: params.deviceLimit,
    });
  }

  async disable(inboundId: number, uuid: string, deviceLimit?: number): Promise<void> {
    await this.updateClient(inboundId, uuid, { enabled: false, ...(deviceLimit !== undefined ? { deviceLimit } : {}) });
  }

  async enable(inboundId: number, uuid: string, deviceLimit?: number): Promise<void> {
    await this.updateClient(inboundId, uuid, { enabled: true, ...(deviceLimit !== undefined ? { deviceLimit } : {}) });
  }

  /**
   * Removes a client from an inbound on 3x-ui.
   *
   * 3x-ui/x-ui endpoint variants differ between versions; we attempt the most common ones.
   * If all fail, caller may fall back to disable().
   */
  async deleteClient(inboundId: number, uuid: string): Promise<void> {
    const body = JSON.stringify({ id: inboundId });
    const attempt = async (path: string, requestBody: string = body): Promise<void> => {
      await this.api.requestJson(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
    };

    // Primary endpoints used by most x-ui/3x-ui versions.
    try {
      await attempt(`/panel/api/inbounds/delClient/${encodeURIComponent(uuid)}`);
      return;
    } catch {
      // continue
    }

    try {
      await attempt(`/panel/api/inbounds/deleteClient/${encodeURIComponent(uuid)}`);
      return;
    } catch {
      // continue
    }

    // Fallback endpoints without UUID in path (some versions).
    const altBody = JSON.stringify({ id: inboundId, uuid });
    try {
      await attempt("/panel/api/inbounds/delClient", altBody);
      return;
    } catch {
      // continue
    }

    await attempt("/panel/api/inbounds/deleteClient", altBody);
  }
}
