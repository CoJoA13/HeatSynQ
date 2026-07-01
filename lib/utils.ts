import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** cents -> whole-dollar display, e.g. 842000 -> "$8,420" */
export function formatMoney(cents: number): string {
  return USD.format(Math.round(cents) / 100);
}

export function formatDate(iso: string): string {
  // Domain dates are midnight-UTC date-only fields (e.g. due/ordered dates).
  // Format in UTC so they don't shift a day earlier in time zones west of UTC.
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}
