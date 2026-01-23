import { formatRuDevices } from "../domain/humanDevices";

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatRub(amountRub: number): string {
  const normalized = Number.isFinite(amountRub) ? Math.trunc(amountRub) : 0;
  const formatted = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(normalized);
  return `${formatted} ₽`;
}

export function formatDevices(current: number): string {
  return formatRuDevices(current);
}
