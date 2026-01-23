import { formatRuDevices } from "../domain/humanDevices";

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatRubMinor(amountMinor: number): string {
  const rub = amountMinor / 100;
  const formatted = rub.toFixed(2).replace(/\.00$/, "");
  return `${formatted} ₽`;
}

export function formatDevices(current: number): string {
  return formatRuDevices(current);
}
