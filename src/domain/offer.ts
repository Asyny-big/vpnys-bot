export class OfferNotAcceptedError extends Error {
  constructor() {
    super("Public offer is not accepted");
    this.name = "OfferNotAcceptedError";
  }
}

export function isOfferAccepted(
  user: { offerAcceptedAt?: Date | null; offerVersion?: string | null },
  currentOfferVersion: string,
): boolean {
  return !!user.offerAcceptedAt && user.offerVersion === currentOfferVersion;
}

export function safeYooKassaDescription(planDays: number): string {
  const days = Math.max(1, Math.floor(Number.isFinite(planDays) ? planDays : 0));
  return `Подписка на цифровой сервис удалённого доступа сроком на ${days} дней`;
}

