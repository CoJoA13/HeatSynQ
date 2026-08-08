import { NextResponse } from "next/server";
import { handle, requireUser, assertRecord, HttpError } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { customerSurchargeOptions, setCustomerSurcharge, deleteCustomerSurcharge } from "@/server/surcharges";

// Every ACTIVE plant-wide surcharge merged with this customer's own override (surcharges.ts's
// customerSurchargeOptions — see its own doc comment for why this composes listSurcharges +
// listCustomerSurcharges behind `customers` permissions rather than pointing the customer page at
// the admin.view-gated /api/admin/surcharges). customers.view, matching every other read on this
// customer.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  return NextResponse.json(await customerSurchargeOptions((await params).id));
});

// A per-customer surcharge override is a price change just like a plant-wide one (task-8 brief's
// opening blockquote) — gated on change_prices in addition to customers.edit, the
// parts/[id]/prices routes' mustCan+mustDo shape. `setCustomerSurcharge` persists the WHOLE row
// it receives (surcharges.ts's `toCustomerSurchargeRow` normalize-on-write), so the body must
// carry every field every time — the customer page's `buildCustomerSurchargeBody`
// (src/lib/customer-surcharge-body.ts) is what guarantees that, not this route.
export const PUT = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "customers", "edit");
  mustDo(user, "change_prices");
  const body: unknown = await req.json();
  assertRecord(body);
  // `setCustomerSurcharge` takes surchargeId as a plain argument, not part of the row its own
  // zod schema validates (that schema is `.strict()`, so passing `surchargeId` straight through
  // as part of `input` would itself be rejected as an unrecognized key) — the orders/[id]/link
  // precedent for a route-level required-string check.
  const { surchargeId, ...rest } = body;
  if (typeof surchargeId !== "string" || surchargeId.length === 0) {
    throw new HttpError(400, "surchargeId is required");
  }
  await setCustomerSurcharge((await params).id, surchargeId, rest);
  return NextResponse.json({ ok: true });
});

// Removing an override is a price change too — the same gate as the PUT. Closes the plan hole
// Task 6's review found: a live override blocks its surcharge's deletion forever
// (customerSurcharge -> surcharge, reference-links.ts) with no way to remove it before this route
// existed. `deleteCustomerSurcharge` (Task 6's fix-wave escape hatch) 404s when there is no live
// override for the pair.
export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "customers", "edit");
  mustDo(user, "change_prices");
  // A request with no body at all, or a body that isn't a JSON object (e.g. `null`), is
  // deliberately not a parse error — the house convention every other body-reading DELETE route
  // follows (customers/[id], parts/[id], certs/[id], orders/[id], shippers/[id],
  // process-templates/[id], admin/roles/[id]; http.ts's `reasonFromBody` documents it for the
  // reason-only case). Fix 2, fix wave 1 review: the bare `await req.json()` this used to be threw
  // a raw SyntaxError for a body-less DELETE, which `handle` does not map to a clean 400 (only
  // ZodError/HttpError are), surfacing as an unhandled 500. The missing surchargeId is reported
  // below as the same field-anchored 400 a body of `{}` would get.
  const body: unknown = await req.json().catch(() => null);
  const rec = body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>) : {};
  const { surchargeId } = rec;
  if (typeof surchargeId !== "string" || surchargeId.length === 0) {
    throw new HttpError(400, "surchargeId is required");
  }
  await deleteCustomerSurcharge((await params).id, surchargeId);
  return NextResponse.json({ ok: true });
});
