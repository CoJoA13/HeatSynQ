"use client";
import { useQuery } from "@tanstack/react-query";
import { useRepositories } from "@/lib/data/provider";
import { queryKeys } from "./keys";

export function useCustomers() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.customers, queryFn: () => r.customers.list() }); }
export function useCustomer(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.customer(id), queryFn: () => r.customers.get(id) }); }
export function useParts() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.parts, queryFn: () => r.parts.list() }); }
export function usePart(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.part(id), queryFn: () => r.parts.get(id) }); }
export function useProcessMasters() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.processMasters, queryFn: () => r.processMasters.list() }); }
export function useSpecifications() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.specifications, queryFn: () => r.specifications.list() }); }
export function useQuotes() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.quotes, queryFn: () => r.quotes.list() }); }
export function useQuote(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.quote(id), queryFn: () => r.quotes.get(id) }); }
export function useWorkOrders() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.workOrders, queryFn: () => r.workOrders.list() }); }
export function useWorkOrder(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.workOrder(id), queryFn: () => r.workOrders.get(id) }); }
export function useInvoices() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.invoices, queryFn: () => r.invoices.list() }); }
export function useCertifications() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.certifications, queryFn: () => r.certifications.list() }); }
export function useOperators() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.operators, queryFn: () => r.operators.list() }); }
export function useProcessMaster(id: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.processMaster(id), queryFn: () => r.processMasters.get(id) }); }
export function useContactsByCustomer(customerId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.contactsByCustomer(customerId), queryFn: () => r.contacts.byCustomer(customerId) }); }
export function usePartsByCustomer(customerId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.partsByCustomer(customerId), queryFn: () => r.parts.byCustomer(customerId) }); }
export function usePriceKeys() { const r = useRepositories(); return useQuery({ queryKey: queryKeys.priceKeys, queryFn: () => r.priceKeys.list() }); }
export function usePricingRulesByPriceKey(priceKeyId: string) { const r = useRepositories(); return useQuery({ queryKey: queryKeys.pricingRulesByPriceKey(priceKeyId), queryFn: () => r.pricingRules.byPriceKey(priceKeyId), enabled: priceKeyId !== "" }); }
