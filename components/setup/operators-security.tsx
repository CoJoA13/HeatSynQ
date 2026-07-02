"use client";
import { useState } from "react";
import { ListCard, MonoId } from "@/components/patterns";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/lib/ui/dialog";
import { Button } from "@/lib/ui/button";
import { Input } from "@/lib/ui/input";
import { roleMeta, ROLE_KEYS } from "@/lib/domain/enums";
import { PERMISSIONS, MATRIX, permissionMeta } from "@/lib/auth/permissions";
import { formatMoney } from "@/lib/utils";
import type { Operator } from "@/lib/domain";

function LimitForm({ operator, busy, onCancel, onConfirm }: {
  operator: Operator; busy: boolean; onCancel: () => void; onConfirm: (quoteAuthLimitCents: number) => void;
}) {
  const [dollars, setDollars] = useState(String(operator.quoteAuthLimitCents / 100));
  const parsed = Number(dollars);
  const valid = dollars.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const cents = valid ? Math.round(parsed * 100) : operator.quoteAuthLimitCents;
  const unchanged = cents === operator.quoteAuthLimitCents;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit quote limit</DialogTitle>
        <DialogDescription>{operator.name} — quotes above this limit route to manager approval.</DialogDescription>
      </DialogHeader>
      <label className="block text-xs">
        <span className="text-text-muted mb-1 block">Quote limit ($)</span>
        <Input aria-label="Quote limit ($)" type="number" min={0} value={dollars} onChange={(e) => setDollars(e.target.value)} />
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button disabled={busy || !valid || unchanged} onClick={() => onConfirm(cents)}>Save limit</Button>
      </DialogFooter>
    </>
  );
}

export function OperatorsSecurity({ operators, canEdit, busy, onSetLimit }: {
  operators: Operator[]; canEdit: boolean; busy: boolean;
  onSetLimit: (operator: Operator, quoteAuthLimitCents: number) => void;
}) {
  const [editing, setEditing] = useState<Operator | null>(null);
  return (
    <div className="space-y-5">
      <div>
        <div className="text-text-muted mb-2 text-xs uppercase tracking-wider">Operators</div>
        <ListCard
          headers={["OPERATOR", "TITLE", "ROLE", "QUOTE LIMIT", ...(canEdit ? [""] : [])]}
          rows={operators.map((o) => [
            <div key="op" data-testid={`operator-row-${o.id}`}>
              <div className="text-[13px] font-medium">{o.name}</div>
              <MonoId className="text-text-muted text-xs">{o.id}</MonoId>
            </div>,
            o.title,
            roleMeta[o.role].label,
            <span key="limit" data-testid={`operator-limit-${o.id}`} className="font-mono">{formatMoney(o.quoteAuthLimitCents)}</span>,
            ...(canEdit
              ? [<Button key="edit" size="sm" variant="outline" data-testid={`edit-limit-${o.id}`} disabled={busy} onClick={() => setEditing(o)}>Edit limit</Button>]
              : []),
          ])}
        />
        <p className="text-text-faint mt-2 text-[11px]">Signatures aren&apos;t modeled yet.</p>
      </div>
      <div>
        <div className="text-text-muted mb-2 text-xs uppercase tracking-wider">Module permissions</div>
        <ListCard
          headers={["PERMISSION", ...ROLE_KEYS.map((r) => roleMeta[r].label.toUpperCase())]}
          rows={PERMISSIONS.map((p) => [
            <span key="p" data-testid={`permission-row-${p}`}>{permissionMeta[p].label}</span>,
            ...ROLE_KEYS.map((role) => (MATRIX[p].includes(role) ? "✓" : "—")),
          ])}
        />
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent showCloseButton={false}>
          {editing && (
            <LimitForm key={editing.id} operator={editing} busy={busy} onCancel={() => setEditing(null)}
              onConfirm={(cents) => { onSetLimit(editing, cents); setEditing(null); }} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
