import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { auditedUpdate } from "./audit";

// The first-run checklist's only persisted state (Phase 8B §5.5/§7) — a one-row singleton cloned
// from billing-config.ts, holding just the two facts that cannot be derived live: whether starting
// document numbers were deliberately confirmed, and whether the checklist was dismissed. Everything
// else (company identity, chart of accounts, customer/part counts, the admin-password reminder) is
// a live signal computed elsewhere (order-entry-readiness.ts / install-readiness.ts).

const ID = "singleton";

export type SetupStateRow = {
  numbersConfirmedAt: Date | null;
  checklistDismissedAt: Date | null;
};

const EMPTY: SetupStateRow = { numbersConfirmedAt: null, checklistDismissedAt: null };

const SAVE = z
  .object({
    numbersConfirmedAt: z.coerce.date().nullable(),
    checklistDismissedAt: z.coerce.date().nullable(),
  })
  .partial()
  .strict();

export async function getSetupState(
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SetupStateRow> {
  // Seeded by the migration; truncateAll and the practice reset re-seed it. An absent row means
  // "nothing configured", never an error (the getBillingConfig precedent).
  const row = await db.setupState.findFirst({ where: { id: ID } });
  if (!row) return EMPTY;
  return { numbersConfirmedAt: row.numbersConfirmedAt, checklistDismissedAt: row.checklistDismissedAt };
}

export async function setSetupState(input: unknown): Promise<SetupStateRow> {
  const data = SAVE.parse(input);
  // SetupState has NO FKs, so DEFAULT isolation — unlike billing-config, which goes Serializable
  // only when it assigns a GL/step-code FK. The upsert's `create` arm self-heals a genuinely
  // rowless database; against any migrated DB the row is seeded (and re-seeded by truncateAll / the
  // practice reset), so `update` is the real path. A create logs as an update with a null `before`.
  await withDbErrors({ entity: "Setup state" }, () =>
    prisma.$transaction((tx) =>
      auditedUpdate(
        "setupState",
        ID,
        () => tx.setupState.upsert({ where: { id: ID }, create: { id: ID, ...data }, update: data }),
        { tx },
      ),
    ),
  );
  return getSetupState();
}
