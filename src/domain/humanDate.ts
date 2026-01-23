export function formatRuDayMonth(date: Date, now: Date = new Date()): string {
  const sameYear = date.getFullYear() === now.getFullYear();
  const formatter = new Intl.DateTimeFormat("ru-RU", sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
  return formatter.format(date);
}
