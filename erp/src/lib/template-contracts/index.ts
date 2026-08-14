/**
 * The template-contract registry (spec §5.3) — one contract per docType, keyed by the string
 * union until Task 3 lands the Prisma `TemplateDocType` enum. All eight of §8's types are
 * registered (Task 1 the order side, Task 2 the billing side); the record stays Partial only
 * because its keys are the string union, and `contractFor` remains the only sanctioned lookup —
 * it throws on an unregistered type, so no caller can validate against `undefined`.
 *
 * `validateConfig(docType, json)` lives HERE, not in ./types.ts, because the registry imports
 * the contract modules, which import ./types — the docType-keyed entry point cannot sit below
 * them without a cycle (the invoice-guards leaf lesson, applied preemptively). The
 * contract-shaped machinery (`validateContractConfig`, `configSchema`, `defaultConfig`) stays in
 * ./types.ts for callers that hold a contract directly.
 */
import {
  TemplateConfigError,
  defaultConfig,
  validateContractConfig,
  type TemplateConfig,
  type TemplateContract,
  type TemplateDocTypeString,
} from "./types";
import { TRAVELER_CONTRACT, DEFAULT_CONFIG as TRAVELER_DEFAULT_CONFIG } from "./traveler";
import { SHIPPER_CONTRACT, DEFAULT_CONFIG as SHIPPER_DEFAULT_CONFIG } from "./shipper";
import { MOS_SHIPPER_CONTRACT, DEFAULT_CONFIG as MOS_SHIPPER_DEFAULT_CONFIG } from "./mos-shipper";
import { BOL_CONTRACT, DEFAULT_CONFIG as BOL_DEFAULT_CONFIG } from "./bol";
import { CERT_CONTRACT, DEFAULT_CONFIG as CERT_DEFAULT_CONFIG } from "./cert";
import { INVOICE_CONTRACT, DEFAULT_CONFIG as INVOICE_DEFAULT_CONFIG } from "./invoice";
import { STATEMENT_CONTRACT, DEFAULT_CONFIG as STATEMENT_DEFAULT_CONFIG } from "./statement";
import { QUOTE_CONTRACT, DEFAULT_CONFIG as QUOTE_DEFAULT_CONFIG } from "./quote";

export * from "./types";
export {
  TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG,
  SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG,
  MOS_SHIPPER_CONTRACT, MOS_SHIPPER_DEFAULT_CONFIG,
  BOL_CONTRACT, BOL_DEFAULT_CONFIG,
  CERT_CONTRACT, CERT_DEFAULT_CONFIG,
  INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG,
  STATEMENT_CONTRACT, STATEMENT_DEFAULT_CONFIG,
  QUOTE_CONTRACT, QUOTE_DEFAULT_CONFIG,
};

export const CONTRACTS: Partial<Record<TemplateDocTypeString, TemplateContract>> = {
  TRAVELER: TRAVELER_CONTRACT,
  SHIPPER: SHIPPER_CONTRACT,
  MOS_SHIPPER: MOS_SHIPPER_CONTRACT,
  BOL: BOL_CONTRACT,
  CERT: CERT_CONTRACT,
  INVOICE: INVOICE_CONTRACT,
  STATEMENT: STATEMENT_CONTRACT,
  QUOTE: QUOTE_CONTRACT,
};

export function contractFor(docType: TemplateDocTypeString): TemplateContract {
  const contract = CONTRACTS[docType];
  if (contract === undefined) {
    throw new TemplateConfigError(`No template contract is registered for docType "${docType}"`);
  }
  return contract;
}

/** Parses a stored config for one docType, applying the §5.3 backfill — see
 *  `validateContractConfig` for the full contract. Throws on an unregistered docType. */
export function validateConfig(docType: TemplateDocTypeString, json: unknown): TemplateConfig {
  return validateContractConfig(contractFor(docType), json);
}

/** The type's complete "today's paper" default — what Task 3's seed and `truncateAll()` build
 *  the Standard templates from. */
export function defaultConfigFor(docType: TemplateDocTypeString): TemplateConfig {
  return defaultConfig(contractFor(docType));
}
