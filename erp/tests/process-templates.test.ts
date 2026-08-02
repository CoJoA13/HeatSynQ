import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  addTemplateStep, updateTemplateStep, removeTemplateStep, reorderTemplateSteps,
} from "@/server/process-templates";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** A single live process step code — the templates service under test doesn't (and shouldn't)
 *  depend on process-step-codes.ts's own service layer to set up its own fixtures. */
async function fixture() {
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  return { code };
}

describe("process templates service", () => {
  beforeEach(truncateAll);

  describe("createTemplate", () => {
    it("rejects a blank or whitespace-only name", async () => {
      await expect(asSystem(() => createTemplate({ name: "" }))).rejects.toThrow();
      await expect(asSystem(() => createTemplate({ name: "   " }))).rejects.toThrow();
    });

    it("trims the name before storing it", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "  Standard Anneal  " }));
      const row = await getTemplate(id);
      expect(row.name).toBe("Standard Anneal");
    });

    it("rejects a name over 120 characters", async () => {
      await expect(asSystem(() => createTemplate({ name: "x".repeat(121) }))).rejects.toThrow();
      const { id } = await asSystem(() => createTemplate({ name: "x".repeat(120) }));
      expect(id).toBeTruthy();
    });

    it("rejects a duplicate LIVE name", async () => {
      await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await expect(asSystem(() => createTemplate({ name: "Standard Anneal" })))
        .rejects.toThrow(HttpError);
      await expect(asSystem(() => createTemplate({ name: "Standard Anneal" })))
        .rejects.toMatchObject({ status: 400 });
    });

    it("starts active with an empty step list", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      const row = await getTemplate(id);
      expect(row.active).toBe(true);
      expect(row.steps).toEqual([]);
    });

    it("writes a create audit entry", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      const entries = await readAudit("processTemplate", id);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("create");
    });
  });

  describe("re-using a soft-deleted template name", () => {
    it("creates a NEW row with its own id, not a revival", async () => {
      const first = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => deleteTemplate(first.id, "keyed by mistake"));

      const second = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      expect(second.id).not.toBe(first.id);

      // The new row is independent — active, empty steps, no trace of the predecessor.
      const row = await getTemplate(second.id);
      expect(row.name).toBe("Standard Anneal");
      expect(row.active).toBe(true);
      expect(row.steps).toEqual([]);

      // The old id stays gone.
      await expect(getTemplate(first.id)).rejects.toMatchObject({ status: 404 });

      // Both ids are independently addressable — creating the second didn't touch the first's
      // history.
      const firstAudit = await readAudit("processTemplate", first.id);
      expect(firstAudit.some((e) => e.action === "delete")).toBe(true);
      const secondAudit = await readAudit("processTemplate", second.id);
      expect(secondAudit).toHaveLength(1);
      expect(secondAudit[0].action).toBe("create");
    });
  });

  describe("listTemplates / getTemplate", () => {
    it("lists live templates by name, hiding soft-deleted ones and inactive ones by default", async () => {
      const a = await asSystem(() => createTemplate({ name: "B Template" }));
      const b = await asSystem(() => createTemplate({ name: "A Template" }));
      const c = await asSystem(() => createTemplate({ name: "C Template" }));
      await asSystem(() => updateTemplate(c.id, { active: false }));
      const d = await asSystem(() => createTemplate({ name: "D Template" }));
      await asSystem(() => deleteTemplate(d.id, "test cleanup"));

      const live = await listTemplates();
      expect(live.map((t) => t.name)).toEqual(["A Template", "B Template"]);
      expect(live.map((t) => t.id)).toEqual([b.id, a.id]);

      const withInactive = await listTemplates({ includeInactive: true });
      expect(withInactive.map((t) => t.name)).toEqual(["A Template", "B Template", "C Template"]);
    });

    it("reports stepCount and updatedAt on the summary", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => addTemplateStep(id, { codeId: code.id }));
      await asSystem(() => addTemplateStep(id, { codeId: code.id }));

      const [summary] = await listTemplates();
      expect(summary.stepCount).toBe(2);
      expect(summary.updatedAt).toBeInstanceOf(Date);
    });

    it("getTemplate 404s on a missing or soft-deleted template", async () => {
      await expect(getTemplate("nonexistent")).rejects.toMatchObject({ status: 404 });
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => deleteTemplate(id, "test cleanup"));
      await expect(getTemplate(id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("updateTemplate", () => {
    it("renames and toggles active", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => updateTemplate(id, { name: "Renamed Anneal", active: false }));
      const row = await getTemplate(id);
      expect(row.name).toBe("Renamed Anneal");
      expect(row.active).toBe(false);
    });

    it("rejects renaming to a live duplicate name", async () => {
      await asSystem(() => createTemplate({ name: "Taken" }));
      const { id } = await asSystem(() => createTemplate({ name: "Available" }));
      await expect(asSystem(() => updateTemplate(id, { name: "Taken" })))
        .rejects.toMatchObject({ status: 400 });
    });

    it("404s on a missing template", async () => {
      await expect(asSystem(() => updateTemplate("nonexistent", { name: "x" })))
        .rejects.toMatchObject({ status: 404 });
    });

    it("404s on a soft-deleted template and writes no audit entry", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => deleteTemplate(id, "test cleanup"));
      const before = await readAudit("processTemplate", id);

      await expect(asSystem(() => updateTemplate(id, { name: "Renamed After Delete" })))
        .rejects.toMatchObject({ status: 404 });

      // Not just "still 404s" — the failed claim must not have appended an update entry after
      // the delete, which would read as a revival in the history.
      const after = await readAudit("processTemplate", id);
      expect(after).toHaveLength(before.length);
      expect(after.some((e) => e.action === "update")).toBe(false);

      // The row itself carries no trace of the attempted rename either.
      const row = await prisma.processTemplate.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe("Standard Anneal");
    });
  });

  describe("deleteTemplate", () => {
    it("requires a non-blank reason", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await expect(asSystem(() => deleteTemplate(id, "")))
        .rejects.toMatchObject({ status: 400, message: "A reason is required" });
      await expect(asSystem(() => deleteTemplate(id, "   ")))
        .rejects.toMatchObject({ status: 400, message: "A reason is required" });
    });

    it("writes the trimmed reason into the audit entry", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => deleteTemplate(id, "  superseded by rev 2  "));

      const entries = await readAudit("processTemplate", id);
      expect(entries[0].action).toBe("delete");
      expect(entries[0].reason).toBe("superseded by rev 2");
    });

    it("404s when the template is already gone", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => deleteTemplate(id, "first delete"));
      await expect(asSystem(() => deleteTemplate(id, "second delete")))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  describe("template steps", () => {
    it("addTemplateStep assigns sequential positions and defaults boilerplate to empty", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));

      const s1 = await asSystem(() => addTemplateStep(id, { codeId: code.id }));
      const s2 = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "Heat to 1650F" }));

      const detail = await getTemplate(id);
      expect(detail.steps).toHaveLength(2);
      expect(detail.steps.map((s) => s.id)).toEqual([s1.id, s2.id]);
      expect(detail.steps.map((s) => s.position)).toEqual([1, 2]);
      expect(detail.steps[0]).toMatchObject({
        codeId: code.id, code: "HT-01", codeName: "Austenitize", boilerplate: "",
      });
      expect(detail.steps[1].boilerplate).toBe("Heat to 1650F");
    });

    it("rejects boilerplate over 4000 characters", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await expect(asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "x".repeat(4001) })))
        .rejects.toThrow();
    });

    it("addTemplateStep 400s on a soft-deleted code and accepts an inactive one", async () => {
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      const deletedCode = await prisma.processStepCode.create({
        data: { code: "DEL-01", name: "Deleted", deletedAt: new Date() },
      });
      await expect(asSystem(() => addTemplateStep(id, { codeId: deletedCode.id })))
        .rejects.toMatchObject({ status: 400 });

      const inactiveCode = await prisma.processStepCode.create({
        data: { code: "INA-01", name: "Inactive", active: false },
      });
      const step = await asSystem(() => addTemplateStep(id, { codeId: inactiveCode.id }));
      expect(step.id).toBeTruthy();
    });

    it("addTemplateStep 404s once the template is soft-deleted", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      await asSystem(() => deleteTemplate(id, "test cleanup"));
      await expect(asSystem(() => addTemplateStep(id, { codeId: code.id })))
        .rejects.toMatchObject({ status: 404 });
    });

    it("updateTemplateStep replaces boilerplate", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      const step = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "A" }));

      await asSystem(() => updateTemplateStep(id, step.id, { boilerplate: "B" }));
      const detail = await getTemplate(id);
      expect(detail.steps[0].boilerplate).toBe("B");
    });

    it("updateTemplateStep 404s on an unknown step id or one belonging to another template", async () => {
      const { code } = await fixture();
      const t1 = await asSystem(() => createTemplate({ name: "Template One" }));
      const t2 = await asSystem(() => createTemplate({ name: "Template Two" }));
      const step = await asSystem(() => addTemplateStep(t1.id, { codeId: code.id }));

      await expect(asSystem(() => updateTemplateStep(t1.id, "nonexistent", { boilerplate: "x" })))
        .rejects.toMatchObject({ status: 404 });
      await expect(asSystem(() => updateTemplateStep(t2.id, step.id, { boilerplate: "x" })))
        .rejects.toMatchObject({ status: 404 });
    });

    it("removeTemplateStep closes the position gap and hard-deletes the row", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      const s1 = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "one" }));
      const s2 = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "two" }));
      const s3 = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "three" }));

      await asSystem(() => removeTemplateStep(id, s2.id));

      const detail = await getTemplate(id);
      expect(detail.steps.map((s) => s.id)).toEqual([s1.id, s3.id]);
      expect(detail.steps.map((s) => s.position)).toEqual([1, 2]);

      const orphan = await prisma.processTemplateStep.findUnique({ where: { id: s2.id } });
      expect(orphan).toBeNull();
    });

    it("reorderTemplateSteps is atomic and keeps positions 1..n", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      const s1 = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "one" }));
      const s2 = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "two" }));
      const s3 = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "three" }));

      await asSystem(() => reorderTemplateSteps(id, [s3.id, s1.id, s2.id]));
      let detail = await getTemplate(id);
      expect(detail.steps.map((s) => s.id)).toEqual([s3.id, s1.id, s2.id]);
      expect(detail.steps.map((s) => s.position)).toEqual([1, 2, 3]);

      // Atomic: a set that doesn't name every live step exactly once is rejected wholesale, and
      // the previous successful order is left untouched.
      await expect(asSystem(() => reorderTemplateSteps(id, [s3.id, s1.id])))
        .rejects.toMatchObject({ status: 400 });
      await expect(asSystem(() => reorderTemplateSteps(id, [s3.id, s1.id, s2.id, "nonexistent"])))
        .rejects.toMatchObject({ status: 400 });

      detail = await getTemplate(id);
      expect(detail.steps.map((s) => s.id)).toEqual([s3.id, s1.id, s2.id]);
      expect(detail.steps.map((s) => s.position)).toEqual([1, 2, 3]);
    });

    it("audit: every step mutation is a template-level update whose after-snapshot shows the change", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));

      const step = await asSystem(() => addTemplateStep(id, { codeId: code.id, boilerplate: "Heat to 1650F" }));

      const entries = await readAudit("processTemplate", id);
      expect(entries[0].action).toBe("update");
      const after = entries[0].after as { steps: { id: string; boilerplate: string; code: { code: string } }[] };
      const before = entries[0].before as { steps: { id: string }[] };
      expect(after.steps.some((s) => s.id === step.id && s.boilerplate === "Heat to 1650F")).toBe(true);
      expect(after.steps.some((s) => s.code.code === "HT-01")).toBe(true);
      expect(before.steps.some((s) => s.id === step.id)).toBe(false);

      await asSystem(() => updateTemplateStep(id, step.id, { boilerplate: "Heat to 1700F" }));
      const editEntries = await readAudit("processTemplate", id);
      const editAfter = editEntries[0].after as { steps: { id: string; boilerplate: string }[] };
      expect(editAfter.steps.find((s) => s.id === step.id)?.boilerplate).toBe("Heat to 1700F");

      await asSystem(() => removeTemplateStep(id, step.id));
      const removeEntries = await readAudit("processTemplate", id);
      const removeAfter = removeEntries[0].after as { steps: { id: string }[] };
      expect(removeAfter.steps.some((s) => s.id === step.id)).toBe(false);
    });

    // A brief real wait between reads, not a mocked clock: @updatedAt's resolution is the
    // millisecond, and asserting `>=` alone would pass even if a step op wrote nothing at all
    // (an unchanged timestamp still satisfies `>=`), so the assertion has to be strict `>`. The
    // 10ms wait is what makes strict `>` deterministic rather than a coin flip on same-millisecond
    // writes.
    it("every step mutation bumps the template's own updatedAt", async () => {
      const { code } = await fixture();
      const { id } = await asSystem(() => createTemplate({ name: "Standard Anneal" }));
      const wait = () => new Promise((resolve) => setTimeout(resolve, 10));
      const readUpdatedAt = async () =>
        (await prisma.processTemplate.findUniqueOrThrow({ where: { id } })).updatedAt;

      let prev = await readUpdatedAt();

      await wait();
      const step = await asSystem(() => addTemplateStep(id, { codeId: code.id }));
      let now = await readUpdatedAt();
      expect(now.getTime()).toBeGreaterThan(prev.getTime());
      prev = now;

      await wait();
      await asSystem(() => updateTemplateStep(id, step.id, { boilerplate: "Heat to 1650F" }));
      now = await readUpdatedAt();
      expect(now.getTime()).toBeGreaterThan(prev.getTime());
      prev = now;

      await wait();
      await asSystem(() => reorderTemplateSteps(id, [step.id]));
      now = await readUpdatedAt();
      expect(now.getTime()).toBeGreaterThan(prev.getTime());
      prev = now;

      await wait();
      await asSystem(() => removeTemplateStep(id, step.id));
      now = await readUpdatedAt();
      expect(now.getTime()).toBeGreaterThan(prev.getTime());
    });
  });
});
