export type Session = {
  accessToken: string;
  email: string;
  tenants: { id: string; name: string; role: string }[];
};
export type Branch = { id: string; name: string };
export type Product = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  price_usd: string;
  tax_category: 'general' | 'reduced' | 'exempt';
  version: number;
  quantity?: string;
  average_cost_base?: string | null;
};
export type Movement = {
  id: string;
  created_at: string;
  delta: string;
  reason: string;
  sku: string;
  name: string;
  actor: string;
};
export type PageResult<T> = { items: T[]; total: number };
export type Summary = {
  products: number;
  with_stock: number;
  without_stock: number;
  branches: number;
};
export type Quote = {
  purchaseTotalBase: string;
  purchaseTotalUsd: string;
  igtfTotalBase: string;
  dueTotalBase: string;
  remainingPrincipalBase: string;
  note: string;
  lines: {
    productId: string;
    sku: string;
    name: string;
    quantity: string;
    priceUsd: string;
    base: string;
    vat: string;
    total: string;
  }[];
};
export type Api = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
export type Page =
  'overview' | 'articles' | 'movements' | 'quote' | 'branches' | 'adjustments' | 'purchases';
export const money = (value: string | number) =>
  new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(value),
  );
export const quantity = (value: string | number) =>
  new Intl.NumberFormat('es-VE', { maximumFractionDigits: 6 }).format(Number(value));
export const dateTime = (value: string) =>
  new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
export const taxLabels = { general: 'General · 16 %', reduced: 'Reducido · 8 %', exempt: 'Exento' };
