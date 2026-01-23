export function formatRuDevices(count: number): string {
  const n = Math.max(0, Math.floor(count));
  const mod10 = n % 10;
  const mod100 = n % 100;

  const word =
    mod10 === 1 && mod100 !== 11
      ? "устройство"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "устройства"
        : "устройств";

  return `${n} ${word}`;
}
