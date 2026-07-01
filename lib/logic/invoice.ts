import type { WorkOrder, Invoice } from "@/lib/domain";

export type NewInvoice = Omit<Invoice, "id" | "createdAt" | "updatedAt" | "version">;

export function toBillInvoiceFromOrder(order: WorkOrder, shippedDate: string): NewInvoice {
  return {
    number: null, customerId: order.customerId, workOrderId: order.id,
    amountCents: order.orderValueCents, status: "to_bill",
    shippedDate, invoicedDate: null, paidDate: null,
  };
}
export function billInvoice(inv: Invoice, number: string, invoicedDate: string): Invoice {
  return { ...inv, status: "sent", number, invoicedDate };
}
export function payInvoice(inv: Invoice, paidDate: string): Invoice {
  return { ...inv, status: "paid", paidDate };
}
