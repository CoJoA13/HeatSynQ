import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import type { Area } from "./permissions";
import { formatDateOnly, todayDateOnly } from "../lib/business-days";
import { renderPdf, renderSheetGroups, jpegDataUri, pngDataUri } from "./pdf/render";
import {
  validateConfig, TemplateConfigError,
  type TemplateConfig, type TemplateDocTypeString,
} from "../lib/template-contracts/index";

// The record reads + settings + builders each print type already uses — a preview reuses the SAME
// read and the SAME builder, minus the store/stamp/printedAt/allocation.
import { travelerSettings, readTravelerData, buildTravelerDefinitions } from "./traveler";
import {
  ticketSettings, readShippingTicketData, bolSettings, readBolData,
} from "./shippers";
import { buildShippingTicketDefinitions } from "./pdf/shipping-ticket";
import { buildBolDefinition } from "./pdf/bol";
import { certPrintSettings, readCertPdfData } from "./certs";
import { buildCertDefinition } from "./pdf/cert";
import { invoicePrintSettings, readInvoicePdfData } from "./invoices";
import { buildInvoiceDefinition } from "./pdf/invoice";
import { buildStatement } from "./statements";
import { buildStatementDefinition } from "./pdf/statement";
import { quotePrintSettings, readQuotePdfData } from "./quotes";
import { buildQuoteDefinition } from "./pdf/quote";

/**
 * The template PREVIEW (Phase 7 spec §5.5): render the editor's SUBMITTED (working, possibly-unsaved)
 * config against a real record the user picks, streaming PDF bytes with ZERO side effects — NO
 * `StoredDocument`, NO `printedAt`, NO finance-charge assessment, NO `updatedAt` bump, NO number
 * allocation.
 *
 * The whole point is that a preview renders the SUBMITTED config DIRECTLY — it does NOT go through
 * `resolveTemplateForPrint` (which requires a PUBLISHED version), so a never-published draft
 * previews exactly as an assigned one would. The only two facts this file reads FROM the template
 * row are its `docType` (which contract validates, which read/builder runs) and its open draft's
 * logo bytes (the logo lives per-version, not in the config — the print path's own §6.3 rule).
 *
 * This module is a top-level CONSUMER of every print service and builder; nothing imports it back,
 * so the wide import graph opens no cycle.
 */

type Db = Prisma.TransactionClient;

/** docType → the print-route permission a preview must ALSO hold (spec §5.5): a preview exposes the
 *  real record's amounts, so it can never be a cheaper read than the print itself. */
export const RECORD_AREA: Record<TemplateDocTypeString, Area> = {
  TRAVELER: "orders",
  SHIPPER: "shipping",
  MOS_SHIPPER: "shipping",
  BOL: "shipping",
  CERT: "certs",
  INVOICE: "invoicing",
  STATEMENT: "receivables",
  QUOTE: "quotes",
};

export type PreviewContext = {
  docType: TemplateDocTypeString;
  /** The open draft's stored logo bytes (per-version — §6.3), or null when the draft carries none. */
  logoImage: Uint8Array | null;
  logoMimeType: string | null;
};

/**
 * The two facts the route needs from the template row: its `docType` (drives the record-area
 * permission gate AND the render dispatch) and its open draft's logo bytes (the preview shows the
 * WORKING logo, which lives on the draft version). A missing/soft-deleted template 404s. Read
 * BEFORE the record-area gate so the docType is known — no record data is touched here.
 */
export async function readPreviewContext(id: string): Promise<PreviewContext> {
  const template = await prisma.documentTemplate.findFirst({
    where: { id, deletedAt: null },
    select: {
      docType: true,
      versions: {
        where: { status: "DRAFT" },
        select: { logoImage: true, logoMimeType: true },
        take: 1,
      },
    },
  });
  if (!template) throw new HttpError(404, "Template not found");
  const draft = template.versions[0] ?? null;
  return {
    docType: template.docType as TemplateDocTypeString,
    logoImage: draft?.logoImage ?? null,
    logoMimeType: draft?.logoMimeType ?? null,
  };
}

export type PreviewInput = {
  /** The in-editor working config — validated here against the docType's contract, so a preview of
   *  an over-budget/invalid config 400s the same as a save, before any render. */
  config: unknown;
  recordId: string;
  /** STATEMENT only (defaults today/false; §5.5). */
  asOf?: string;
  combineFamily?: boolean;
  /** TRAVELER only — a single load, else every load (bounded by the print path's own #43 cap). */
  loadNumber?: number;
};

/** Read-only reads on a single RepeatableRead snapshot (the getTemplate/buildStatement posture): no
 *  claim, no write — the preview mutates nothing, so the print path's Serializable brackets and row
 *  claims are deliberately absent. */
function readOnly<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/**
 * Renders the submitted config against the picked record. Validates the config FIRST (an invalid/
 * over-budget config throws a named 400 with no render — the save-path parity §5.5 wants), embeds
 * the draft's stored logo when the config places one (the print path's §6.3 rule), then reuses the
 * exact per-type read + builder the print path uses — minus every side effect.
 *
 * `signerUserId` is the acting user, used ONLY by the CERT preview's signature block (the print
 * path signs with the caller's own user — §3.11; a preview mirrors that).
 */
export async function renderPreview(
  ctx: PreviewContext, input: PreviewInput, signerUserId: string,
): Promise<Buffer> {
  const { docType } = ctx;
  let config: TemplateConfig;
  try {
    config = validateConfig(docType, input.config);
  } catch (err) {
    if (err instanceof TemplateConfigError) throw new HttpError(400, err.message);
    throw err; // a ZodError shape problem stays for `handle` to translate to a 400
  }

  // Logo bytes → data URI by the STORED mime type, ONLY when the config also places a logo — the
  // exact rule every print path applies (an unplaced upload converts nothing).
  const logoDataUri = ctx.logoImage !== null && config.logo !== null
    ? (ctx.logoMimeType === "image/jpeg"
        ? jpegDataUri(Buffer.from(ctx.logoImage))
        : pngDataUri(Buffer.from(ctx.logoImage)))
    : undefined;

  switch (docType) {
    case "TRAVELER": {
      const settings = await travelerSettings();
      const data = await readOnly((tx) => readTravelerData(tx, input.recordId, settings, input.loadNumber));
      return renderSheetGroups(buildTravelerDefinitions(data, config, logoDataUri));
    }
    case "SHIPPER":
    case "MOS_SHIPPER": {
      // The liability text binds at the DATA SEAM from the SUBMITTED config (the print path's shape).
      const settings = await ticketSettings();
      const data = await readOnly((tx) => readShippingTicketData(tx, input.recordId,
        { ...settings, liabilityText: config.textBlocks.shipper_liability_text }, undefined));
      return renderSheetGroups(buildShippingTicketDefinitions(data, docType, config, logoDataUri));
    }
    case "BOL": {
      const settings = await bolSettings();
      const data = await readOnly(async (tx) => {
        const shipper = await tx.shipper.findFirst({
          where: { id: input.recordId }, select: { bolNumber: true, shipperNumber: true },
        });
        if (!shipper) throw new HttpError(404, "Shipment not found");
        // A preview NEVER allocates a BOL number (side-effect-free — §5.5): show the existing one, or
        // the shipper number as a sample stand-in when none has been printed yet.
        return readBolData(tx, input.recordId, shipper.bolNumber ?? shipper.shipperNumber, settings);
      });
      return renderPdf(buildBolDefinition(data, config, logoDataUri));
    }
    case "CERT": {
      const settings = await certPrintSettings();
      const signer = await prisma.user.findFirst({
        where: { id: signerUserId },
        select: { displayName: true, title: true, signatureImage: true, signatureMimeType: true },
      });
      if (!signer) throw new HttpError(404, "User not found");
      // The cert_statement binds at the DATA SEAM from the SUBMITTED config (the print path's shape).
      const { data } = await readOnly((tx) => readCertPdfData(tx, input.recordId,
        { ...settings, statement: config.textBlocks.cert_statement }, signer, formatDateOnly(todayDateOnly())));
      return renderPdf(buildCertDefinition(data, config, logoDataUri));
    }
    case "INVOICE": {
      const settings = await invoicePrintSettings();
      const data = await readOnly((tx) => readInvoicePdfData(tx, input.recordId, settings));
      return renderPdf(buildInvoiceDefinition(data, config, logoDataUri));
    }
    case "STATEMENT": {
      // `buildStatement` opens its own RepeatableRead tx. Finance-charge assessment is FORCED OFF
      // (the write path on a real statement run — §5.5); asOf/combineFamily default today/false.
      const data = await buildStatement(input.recordId, {
        asOf: input.asOf, combineFamily: input.combineFamily ?? false, assessFinanceCharges: false,
      });
      return renderPdf(buildStatementDefinition(data, config, logoDataUri));
    }
    case "QUOTE": {
      // The intro + liability texts bind at the DATA SEAM from the SUBMITTED config.
      const settings = await quotePrintSettings();
      const data = await readOnly((tx) => readQuotePdfData(tx, input.recordId, {
        ...settings,
        introText: config.textBlocks.quote_intro_text,
        liabilityText: config.textBlocks.quote_liability_text,
      }));
      return renderPdf(buildQuoteDefinition(data, config, logoDataUri));
    }
    default: {
      const _exhaustive: never = docType;
      throw new Error(`Unhandled preview docType: ${String(_exhaustive)}`);
    }
  }
}
