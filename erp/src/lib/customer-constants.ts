// Pure constants — safe to import from client components (no server imports).
export const ADDRESS_KINDS = ["SHIP_TO", "BILL_TO", "RECEIVED_FROM"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

export const ADDRESS_KIND_LABELS: Record<AddressKind, string> = {
  SHIP_TO: "Ship to",
  BILL_TO: "Bill to",
  RECEIVED_FROM: "Received from",
};

export const CONTACT_FLAGS = [
  { key: "getsShippers", label: "Shippers" },
  { key: "getsInvoices", label: "Invoices" },
  { key: "getsStatements", label: "Statements" },
  { key: "getsCerts", label: "Certs" },
] as const;

/** Column order for spreadsheet paste, and the header hint shown above the paste box. */
export const CUSTOMER_PASTE_COLUMNS = ["code", "name", "defaultPo", "orderNotes"] as const;
