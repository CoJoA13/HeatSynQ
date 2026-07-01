"use client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { DetailHeader, FormField, ErrorSummary } from "@/components/patterns";
import { Input } from "@/lib/ui/input";
import { Button } from "@/lib/ui/button";
import { Label } from "@/lib/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/lib/ui/select";
import type { Part, Specification, ProcessMaster, PriceKey } from "@/lib/domain";

export const partFormSchema = z.object({
  partNumber: z.string().min(1, "Part number is required"),
  description: z.string().min(1, "Description is required"),
  material: z.string().min(1, "Material is required"),
  drawingRev: z.string(),
  hardness: z.string(),
  caseDepth: z.string(),
  specificationId: z.string().nullable(),
  processMasterId: z.string().nullable(),
  priceKeyId: z.string().nullable(),
  inspectionScale: z.string(),
  inspectionSample: z.string(),
});
export type PartFormValues = z.infer<typeof partFormSchema>;

const NONE = "__none__";

export function PartEditor({
  part,
  specifications,
  processMasters,
  priceKeys,
  onSave,
  saving,
  saved,
}: {
  part: Part;
  specifications: Specification[];
  processMasters: ProcessMaster[];
  priceKeys: PriceKey[];
  onSave: (values: PartFormValues) => void;
  saving: boolean;
  saved: boolean;
}) {
  const {
    register, handleSubmit, setValue, watch,
    formState: { errors, isValid },
  } = useForm<PartFormValues>({
    resolver: zodResolver(partFormSchema),
    mode: "onChange",
    defaultValues: {
      partNumber: part.partNumber, description: part.description, material: part.material,
      drawingRev: part.drawingRev, hardness: part.hardness, caseDepth: part.caseDepth,
      specificationId: part.specificationId, processMasterId: part.processMasterId, priceKeyId: part.priceKeyId,
      inspectionScale: part.inspectionScale, inspectionSample: part.inspectionSample,
    },
  });
  const errorList = Object.values(errors)
    .map((e) => e?.message)
    .filter((m): m is string => Boolean(m));

  return (
    <form onSubmit={handleSubmit(onSave)}>
      <DetailHeader
        backHref="/parts"
        backLabel="Part Maintenance"
        title={<span className="font-mono">{part.partNumber}</span>}
        subtitle="Edit part record"
        actions={<Button type="submit" disabled={!isValid || saving}>{saving ? "Saving…" : "Save part"}</Button>}
      />
      {saved && (
        <div className="mb-4 rounded-card border border-status-success-tint bg-status-success-tint/40 p-3 text-status-success text-xs">
          Part saved.
        </div>
      )}
      <ErrorSummary errors={errorList} />
      <div className="mt-4 grid grid-cols-2 gap-4 rounded-card border border-border bg-surface p-4">
        <FormField label="Part number" htmlFor="partNumber" error={errors.partNumber?.message}><Input id="partNumber" {...register("partNumber")} /></FormField>
        <FormField label="Description" htmlFor="description" error={errors.description?.message}><Input id="description" {...register("description")} /></FormField>
        <FormField label="Material" htmlFor="material" error={errors.material?.message}><Input id="material" {...register("material")} /></FormField>
        <FormField label="Drawing rev" htmlFor="drawingRev"><Input id="drawingRev" {...register("drawingRev")} /></FormField>
        <FormField label="Hardness" htmlFor="hardness"><Input id="hardness" {...register("hardness")} /></FormField>
        <FormField label="Case depth" htmlFor="caseDepth"><Input id="caseDepth" {...register("caseDepth")} /></FormField>
        {/* eslint-disable-next-line react-hooks/incompatible-library */}
        <RefSelect label="Specification" value={watch("specificationId")} onChange={(v) => setValue("specificationId", v, { shouldValidate: true })} options={specifications.map((s) => ({ value: s.id, label: s.code }))} />
        <RefSelect label="Process master" value={watch("processMasterId")} onChange={(v) => setValue("processMasterId", v, { shouldValidate: true })} options={processMasters.map((p) => ({ value: p.id, label: p.code }))} />
        <RefSelect label="Price key" value={watch("priceKeyId")} onChange={(v) => setValue("priceKeyId", v, { shouldValidate: true })} options={priceKeys.map((k) => ({ value: k.id, label: k.code }))} />
        <FormField label="Inspection scale" htmlFor="inspectionScale"><Input id="inspectionScale" {...register("inspectionScale")} /></FormField>
        <FormField label="Inspection sample" htmlFor="inspectionSample"><Input id="inspectionSample" {...register("inspectionSample")} /></FormField>
      </div>
    </form>
  );
}

function RefSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
        <SelectTrigger className="w-full"><SelectValue placeholder="None" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None</SelectItem>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
