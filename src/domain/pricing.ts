export const EXTRA_DEVICE_RUB = 50;

const DAYS_PER_MONTH = 30;

export type DevicePricingInput =
	| Readonly<{
		kind: "new_subscription";
		basePlanRub: number;
		planDays: number;
		selectedDevices: number;
		includedDevices?: number; // default: 1
		extraDeviceRubPer30Days?: number; // default: EXTRA_DEVICE_RUB
	}>
	| Readonly<{
		kind: "add_devices";
		currentDeviceLimit: number;
		newDeviceLimit: number;
		daysRemaining: number;
		extraDeviceRubPer30Days?: number; // default: EXTRA_DEVICE_RUB
	}>;

export type DevicePricingResult = Readonly<{
	monthsCharged: number;
	extraDevicesCharged: number;
	extraPriceRub: number;
	totalRub: number;
}>;

export function monthsByDaysCeil(days: number): number {
	const safeDays = Number.isFinite(days) ? days : 0;
	if (safeDays <= 0) return 0;
	return Math.ceil(safeDays / DAYS_PER_MONTH);
}

function rubInt(value: number): number {
	const v = Number.isFinite(value) ? value : 0;
	return Math.trunc(v);
}

export function calcDevicePricing(input: DevicePricingInput): DevicePricingResult {
	const extraRubPer30 = rubInt(input.extraDeviceRubPer30Days ?? EXTRA_DEVICE_RUB);
	if (extraRubPer30 < 0) throw new Error("extraDeviceRubPer30Days must be >= 0");

	if (input.kind === "new_subscription") {
		const included = Math.max(0, Math.floor(Number.isFinite(input.includedDevices) ? input.includedDevices : 1));
		const selected = Math.max(0, Math.floor(Number.isFinite(input.selectedDevices) ? input.selectedDevices : 0));
		const months = monthsByDaysCeil(input.planDays);

		const extraDevices = Math.max(0, selected - included);
		const extraPriceRub = rubInt(extraDevices * extraRubPer30 * months);
		const basePlanRub = rubInt(input.basePlanRub);
		const totalRub = rubInt(basePlanRub + extraPriceRub);

		return { monthsCharged: months, extraDevicesCharged: extraDevices, extraPriceRub, totalRub };
	}

	const current = Math.max(0, Math.floor(Number.isFinite(input.currentDeviceLimit) ? input.currentDeviceLimit : 0));
	const next = Math.max(0, Math.floor(Number.isFinite(input.newDeviceLimit) ? input.newDeviceLimit : 0));
	const added = Math.max(0, next - current);
	const months = monthsByDaysCeil(input.daysRemaining);

	const extraPriceRub = rubInt(added * extraRubPer30 * months);
	return { monthsCharged: months, extraDevicesCharged: added, extraPriceRub, totalRub: extraPriceRub };
}
