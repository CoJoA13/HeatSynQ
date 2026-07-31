"use client";
import { useState } from "react";
import { ReferenceTable } from "@/components/ReferenceTable";
import { REFERENCE_KINDS, REFERENCE_LABELS, type ReferenceKind } from "@/lib/reference-constants";

export default function ReferencePage() {
  const [kind, setKind] = useState<ReferenceKind>("glAccount");
  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Reference data</h1>
      <div className="flex gap-6">
        <ul className="w-56 shrink-0 divide-y rounded border bg-white text-sm">
          {REFERENCE_KINDS.map((k) => (
            <li key={k}
                className={`cursor-pointer px-3 py-2 ${k === kind ? "bg-slate-100 font-medium" : ""}`}
                onClick={() => setKind(k)}>
              {REFERENCE_LABELS[k].plural}
            </li>
          ))}
        </ul>
        <div className="flex-1"><ReferenceTable key={kind} kind={kind} /></div>
      </div>
    </div>
  );
}
