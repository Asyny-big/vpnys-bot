export const MIN_DEVICE_LIMIT = 1 as const;
export const MAX_DEVICE_LIMIT = 6 as const;

export function clampDeviceLimit(value: number): number {
  if (!Number.isFinite(value)) return MIN_DEVICE_LIMIT;
  const floored = Math.floor(value);
  if (floored < MIN_DEVICE_LIMIT) return MIN_DEVICE_LIMIT;
  if (floored > MAX_DEVICE_LIMIT) return MAX_DEVICE_LIMIT;
  return floored;
}
