import { randomBytes, randomUUID } from "node:crypto";
import { ThreeXUiApiClient, ThreeXUiError } from "./threeXuiApiClient";

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
}>;

export class ThreeXUiService {
  constructor(private readonly api: ThreeXUiApiClient) {}

  telegramEmail(telegramId: string): string {
    return `tg:${telegramId}`;
  }

  subscriptionUrl(publicPanelBaseUrl: string, subscriptionId: string): string {
    const base = publicPanelBaseUrl.replace(/\/+$/, "");
    return `${base}/sub/${encodeURIComponent(subscriptionId)}`;
  }

  async listInbounds(): Promise<Inbound[]> {
    return await this.api.requestJson<Inbound[]>("/panel/api/inbounds/list", { method: "GET" });
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
    };
  }

  private buildClientPatch(input: {
    uuid: string;
    email: string;
    subscriptionId: string;
    expiresAt?: Date;
    enabled: boolean;
    flow?: string;
  }): any {
    const expiryTime = input.expiresAt ? input.expiresAt.getTime() : 0;
    const patch: any = {
      id: input.uuid,
      email: input.email,
      enable: input.enabled,
      expiryTime,
      subId: input.subscriptionId,
      limitIp: 1,
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
          clients: [this.buildClientPatch({ uuid, email, subscriptionId: subId, enabled: true, flow: params.flow })],
        }),
      }),
    });

    const created = await this.findClientByEmail(params.inboundId, email);
    if (!created) throw new ThreeXUiError("3x-ui client creation succeeded but client not found afterwards");
    if (!created.subscriptionId) {
      // Some versions might not persist subId in the client settings until update; enforce.
      await this.updateClient(params.inboundId, uuid, { subscriptionId: subId });
      const reread = await this.findClientByEmail(params.inboundId, email);
      if (!reread?.subscriptionId) throw new ThreeXUiError("3x-ui did not persist subscriptionId");
      return reread;
    }
    return created;
  }

  async updateClient(
    inboundId: number,
    uuid: string,
    patch: Partial<Pick<ThreeXUiClientInfo, "expiresAt" | "enabled" | "subscriptionId">>,
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

    const updatedClient = {
      ...raw,
      enable: patch.enabled ?? raw.enable ?? true,
      expiryTime,
      subId: patch.subscriptionId ?? raw.subId ?? "",
      // Enforce 1 IP as "1 device" approximation.
      limitIp: 1,
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
  }): Promise<void> {
    await this.updateClient(params.inboundId, params.uuid, {
      expiresAt: params.expiresAt,
      enabled: params.enabled,
      subscriptionId: params.subscriptionId,
    });
  }

  async disable(inboundId: number, uuid: string): Promise<void> {
    await this.updateClient(inboundId, uuid, { enabled: false });
  }

  async enable(inboundId: number, uuid: string): Promise<void> {
    await this.updateClient(inboundId, uuid, { enabled: true });
  }
}
