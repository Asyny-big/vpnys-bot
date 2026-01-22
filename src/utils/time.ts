export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function formatUtc(date: Date): string {
  // Telegram UI: keep it simple and unambiguous.
  return date.toISOString().replace(".000Z", "Z");
}

