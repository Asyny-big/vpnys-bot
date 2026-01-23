export const SubscriptionStatus = {
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  DISABLED: "DISABLED",
} as const;

export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const PaymentProvider = {
  YOOKASSA: "YOOKASSA",
  CRYPTOBOT: "CRYPTOBOT",
} as const;

export type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];

export const PaymentType = {
  SUBSCRIPTION: "SUBSCRIPTION",
  DEVICE_SLOT: "DEVICE_SLOT",
} as const;

export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];

export const PaymentStatus = {
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  CANCELED: "CANCELED",
  FAILED: "FAILED",
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];
