import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { URL } from "node:url";
import type { ThreeXUiService } from "../integrations/threeXui/threeXuiService";
import type { SubscriptionService } from "../modules/subscription/subscriptionService";
import { buildSubscription } from "../modules/subscription/subscriptionBuilder";

const ESTONIA_SERVER_NAME = "🇪🇪 Estonia • LisVPN";

function publicHostFromBaseUrl(publicPanelBaseUrl: string): string {
  const url = new URL(publicPanelBaseUrl);
  return url.hostname;
}

export async function registerSubscriptionRoutes(
  app: FastifyInstance,
  deps: Readonly<{
    prisma: PrismaClient;
    subscriptions: SubscriptionService;
    xui: ThreeXUiService;
    publicPanelBaseUrl: string;
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
      return await reply.code(404).type("text/plain; charset=utf-8").send("Not found\n");
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
              host: publicHostFromBaseUrl(deps.publicPanelBaseUrl),
              uuid: state.subscription.xuiClientUuid,
              flow: deps.xuiClientFlow,
              template: await deps.xui.getVlessRealityTemplate(deps.xuiInboundId),
            },
            // Future: add Germany as a second server by pushing another object here.
          ]
        : [],
    );

    for (const [key, value] of Object.entries(built.headers)) reply.header(key, value);
    return await reply.send(built.body);
  });
}
