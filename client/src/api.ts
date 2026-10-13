export interface ExplorerColumn {
  name: string;
  typeName: string;
  typeText: string;
}

export interface ExplorerFilter {
  column: string;
  operator: string;
  value?: string;
}

export interface QueryBody {
  catalog: string;
  schema: string;
  table: string;
  filters: ExplorerFilter[];
  search?: string;
  columns?: string[];
}

export interface PreviewResponse {
  columns: ExplorerColumn[];
  rows: (string | null)[][];
}

/** Max rows an .xlsx worksheet can hold, minus the header row. */
export const EXCEL_MAX_DATA_ROWS = 1_048_575;

const BASE = '/api/catalog-explorer';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Erro ${res.status}`);
  return data as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Erro ${res.status}`);
  return data as T;
}

function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export const api = {
  catalogs: () =>
    getJson<{ catalogs: string[] }>(`${BASE}/catalogs`).then((d) => d.catalogs),
  schemas: (catalog: string) =>
    getJson<{ schemas: string[] }>(
      `${BASE}/schemas?catalog=${encodeURIComponent(catalog)}`,
    ).then((d) => d.schemas),
  tables: (catalog: string, schema: string) =>
    getJson<{ tables: string[] }>(
      `${BASE}/tables?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`,
    ).then((d) => d.tables),
  preview: (body: QueryBody) => postJson<PreviewResponse>(`${BASE}/preview`, body),
  count: (body: QueryBody) =>
    postJson<{ count: number }>(`${BASE}/count`, body).then((d) => d.count),
};

export function exportUrl(format: 'csv' | 'xlsx', body: QueryBody): string {
  const payload = toBase64Utf8(JSON.stringify(body));
  return `${BASE}/export?format=${format}&payload=${encodeURIComponent(payload)}`;
}

export interface OperatorDef {
  value: string;
  label: string;
  needsValue: boolean;
}

export const OPERATORS: OperatorDef[] = [
  { value: 'equals', label: 'igual a', needsValue: true },
  { value: 'not_equals', label: 'diferente de', needsValue: true },
  { value: 'contains', label: 'contém', needsValue: true },
  { value: 'starts_with', label: 'começa com', needsValue: true },
  { value: 'ends_with', label: 'termina com', needsValue: true },
  { value: 'gt', label: 'maior que', needsValue: true },
  { value: 'gte', label: 'maior ou igual a', needsValue: true },
  { value: 'lt', label: 'menor que', needsValue: true },
  { value: 'lte', label: 'menor ou igual a', needsValue: true },
  { value: 'is_null', label: 'é nulo', needsValue: false },
  { value: 'is_not_null', label: 'não é nulo', needsValue: false },
];

export function operatorNeedsValue(op: string): boolean {
  return OPERATORS.find((o) => o.value === op)?.needsValue ?? true;
}
