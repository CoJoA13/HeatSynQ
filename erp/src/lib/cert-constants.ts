// Pure constants only — no server-only imports. Safe to import from client components.
export const CERT_SCOPES = ["ORDER", "LOAD", "SHIPMENT"] as const;
export type CertScopeValue = (typeof CERT_SCOPES)[number];
export const CERT_SCOPE_LABELS: Record<CertScopeValue, string> = {
  ORDER: "By order",
  LOAD: "By load",
  SHIPMENT: "By shipment",
};

export const FREIGHT_TERMS = ["PREPAID", "COLLECT"] as const;
export type FreightTermsValue = (typeof FREIGHT_TERMS)[number];
export const FREIGHT_TERMS_LABELS: Record<FreightTermsValue, string> = {
  PREPAID: "Prepaid",
  COLLECT: "Collect",
};
