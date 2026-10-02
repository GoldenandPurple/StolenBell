/**
 * Loose shapes for the parts of Toast API responses this server reads.
 * Toast may add fields or enum values at any time, so everything not needed
 * is left untyped and every field is treated as optional.
 */

export interface ToastReference {
  guid: string;
  entityType?: string;
}

export interface ToastRestaurant {
  guid?: string;
  general?: {
    name?: string;
    locationName?: string;
    timeZone?: string;
    currencyCode?: string;
  };
}

export interface ToastJob {
  guid: string;
  title?: string;
  tipped?: boolean;
  deleted?: boolean;
}

export interface ToastEmployee {
  guid: string;
  firstName?: string;
  lastName?: string;
  chosenName?: string;
  deleted?: boolean;
  jobReferences?: ToastReference[];
}

export interface ToastTimeEntry {
  guid: string;
  employeeReference?: ToastReference;
  jobReference?: ToastReference | null;
  businessDate?: string; // yyyyMMdd
  inDate?: string;
  outDate?: string | null;
  regularHours?: number;
  overtimeHours?: number;
  hourlyWage?: number;
  declaredCashTips?: number;
  nonCashTips?: number;
  cashGratuityServiceCharges?: number;
  nonCashGratuityServiceCharges?: number;
  tipsWithheld?: number;
  deleted?: boolean;
}

export interface ToastSalesCategory {
  guid: string;
  name?: string;
}

export interface ToastRevenueCenter {
  guid: string;
  name?: string;
}

export interface ToastSelection {
  displayName?: string;
  quantity?: number;
  price?: number; // net of discounts, excludes tax
  preDiscountPrice?: number;
  voided?: boolean;
  salesCategory?: ToastReference | null;
}

export interface ToastPayment {
  type?: string; // CASH, CREDIT, GIFTCARD, ...
  amount?: number;
  tipAmount?: number;
  refundStatus?: string;
  paymentStatus?: string;
  voidInfo?: unknown;
}

export interface ToastServiceCharge {
  name?: string;
  chargeAmount?: number;
  gratuity?: boolean;
}

export interface ToastCheck {
  guid?: string;
  amount?: number;
  taxAmount?: number;
  totalAmount?: number;
  voided?: boolean;
  deleted?: boolean;
  selections?: ToastSelection[];
  payments?: ToastPayment[];
  appliedServiceCharges?: ToastServiceCharge[];
  appliedDiscounts?: { discountAmount?: number }[];
}

export interface ToastOrder {
  guid: string;
  businessDate?: number; // yyyyMMdd
  voided?: boolean;
  deleted?: boolean;
  numberOfGuests?: number;
  server?: ToastReference | null;
  revenueCenter?: ToastReference | null;
  diningOption?: ToastReference | null;
  checks?: ToastCheck[];
}
