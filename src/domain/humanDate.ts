export function formatRuDayMonth(date: Date, now: Date = new Date()): string {
  const sameYear = date.getFullYear() === now.getFullYear();
  const formatter = new Intl.DateTimeFormat("ru-RU", sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
  return formatter.format(date);
}

export function formatRuDateTime(date: Date, opts?: { timeZone?: string }): string {
  const timeZone = opts?.timeZone ?? "Europe/Moscow";
  const parts = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(date);

  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";

  const day = pick("day");
  const month = pick("month");
  const year = pick("year");
  const hour = pick("hour");
  const minute = pick("minute");

  // Example: "6 февраля 2026, 13:05"
  return [day, month, year].filter(Boolean).join(" ") + (hour && minute ? `, ${hour}:${minute}` : "");
}
