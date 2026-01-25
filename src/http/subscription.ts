import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { URL } from "node:url";
import type { ThreeXUiService } from "../integrations/threeXui/threeXuiService";
import type { SubscriptionService } from "../modules/subscription/subscriptionService";
import { buildSubscription } from "../modules/subscription/subscriptionBuilder";

const ESTONIA_SERVER_NAME = "🇪🇪 Estonia • LisVPN";

function hostnameFromUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.hostname;
}

export async function registerSubscriptionRoutes(
  app: FastifyInstance,
  deps: Readonly<{
    prisma: PrismaClient;
    subscriptions: SubscriptionService;
    xui: ThreeXUiService;
    backendPublicUrl: string;
    telegramBotUrl: string;
    xuiInboundId: number;
    xuiClientFlow?: string;
  }>,
): Promise<void> {
  app.get<{ Params: { token: string } }>("/sub/:token", async (req, reply) => {
    const token = String(req.params.token ?? "").trim();
    if (!token) return await reply.code(400).type("text/plain; charset=utf-8").send("Bad request\n");

    const row = await deps.prisma.subscription.findUnique({
      where: { xuiSubscriptionId: token },
      include: { user: true },
    });

    if (!row) {
      const built = buildSubscription({ enabled: false, expiresAt: null, telegramBotUrl: deps.telegramBotUrl }, []);
      for (const [key, value] of Object.entries(built.headers)) reply.header(key, value);
      return await reply.code(200).send(built.body);
    }

    // Avoid hitting 3x-ui on every client refresh, but do sync when we likely need it.
    const nowMs = Date.now();
    const paidUntilMs = row.paidUntil?.getTime() ?? 0;
    const expiresMs = row.expiresAt?.getTime() ?? 0;
    const needsExtend =
      paidUntilMs > nowMs && (expiresMs === 0 || expiresMs < paidUntilMs);
    const lastSyncMs = row.lastSyncedAt?.getTime() ?? 0;
    const tooOld = lastSyncMs === 0 || nowMs - lastSyncMs > 2 * 60 * 1000;

    const state = needsExtend || tooOld
      ? await deps.subscriptions.syncFromXui(row.user)
      : { subscription: row, expiresAt: row.expiresAt ?? undefined, enabled: row.enabled };

    const effectiveExpiresAt =
      state.expiresAt && state.subscription.paidUntil
        ? (state.expiresAt.getTime() > state.subscription.paidUntil.getTime() ? state.expiresAt : state.subscription.paidUntil)
        : (state.expiresAt ?? state.subscription.paidUntil ?? undefined);

    const isActive = !!effectiveExpiresAt && effectiveExpiresAt.getTime() > nowMs && state.enabled;

    const built = buildSubscription(
      { enabled: state.enabled, expiresAt: effectiveExpiresAt, telegramBotUrl: deps.telegramBotUrl },
      isActive
        ? [
            {
              name: ESTONIA_SERVER_NAME,
              host: hostnameFromUrl(deps.backendPublicUrl),
              uuid: state.subscription.xuiClientUuid,
              flow: deps.xuiClientFlow,
              template: await deps.xui.getVlessRealityTemplate(deps.xuiInboundId),
            },
            // Future: add Germany as a second server by pushing another object here.
          ]
        : [],
    );

    for (const [key, value] of Object.entries(built.headers)) reply.header(key, value);
    return await reply.code(200).send(built.body);
  });
}
