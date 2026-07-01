import { Label } from "@/lib/ui/label";
export function FormField({ label, htmlFor, error, children }: {
  label: string; htmlFor: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-status-danger text-xs">{error}</p>}
    </div>
  );
}
