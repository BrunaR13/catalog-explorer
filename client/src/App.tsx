import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@databricks/appkit-ui/react';
import {
  AlertCircle,
  Columns3,
  Database,
  Download,
  FileSpreadsheet,
  Filter,
  Plus,
  Search,
  Table2,
  X,
} from 'lucide-react';
import { SearchableSelect } from './components/SearchableSelect';
import {
  api,
  EXCEL_MAX_DATA_ROWS,
  exportFileUrl,
  exportStatus,
  OPERATORS,
  operatorNeedsValue,
  startExport,
  type ExplorerColumn,
  type QueryBody,
} from './api';

const numberFmt = new Intl.NumberFormat('pt-BR');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DraftFilter {
  id: number;
  column: string;
  operator: string;
  value: string;
}

interface CommittedQuery {
  filters: { column: string; operator: string; value?: string }[];
  search: string;
}

interface ExportState {
  format: 'csv' | 'xlsx';
  state: 'building' | 'ready' | 'error';
  rowCount: number;
}

let filterSeq = 1;

export default function App() {
  // selection
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [catalogsLoading, setCatalogsLoading] = useState(true);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);

  const [catalog, setCatalog] = useState<string | null>(null);
  const [schema, setSchema] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);

  // data
  const [columns, setColumns] = useState<ExplorerColumn[]>([]);
  const [rows, setRows] = useState<(string | null)[][]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);

  // filters
  const [drafts, setDrafts] = useState<DraftFilter[]>([]);
  const [search, setSearch] = useState('');
  const [committed, setCommitted] = useState<CommittedQuery>({ filters: [], search: '' });

  // export
  const [exportCols, setExportCols] = useState<string[]>([]);
  const [truncateOpen, setTruncateOpen] = useState(false);
  const [exportJob, setExportJob] = useState<ExportState | null>(null);
  const exportRunRef = useRef(0);

  // ---- loaders ----
  useEffect(() => {
    setCatalogsLoading(true);
    api
      .catalogs()
      .then(setCatalogs)
      .catch((e) => setError(e.message))
      .finally(() => setCatalogsLoading(false));
  }, []);

  const resetTableState = useCallback(() => {
    setColumns([]);
    setRows([]);
    setRowCount(null);
    setDrafts([]);
    setSearch('');
    setExportCols([]);
    setCommitted({ filters: [], search: '' });
    setError(null);
    exportRunRef.current++; // cancel any in-flight export polling
    setExportJob(null);
  }, []);

  const handleSelectCatalog = useCallback(
    (c: string) => {
      setCatalog(c);
      setSchema(null);
      setTable(null);
      setSchemas([]);
      setTables([]);
      resetTableState();
      setSchemasLoading(true);
      api
        .schemas(c)
        .then(setSchemas)
        .catch((e) => setError(e.message))
        .finally(() => setSchemasLoading(false));
    },
    [resetTableState],
  );

  const handleSelectSchema = useCallback(
    (s: string) => {
      setSchema(s);
      setTable(null);
      setTables([]);
      resetTableState();
      if (!catalog) return;
      setTablesLoading(true);
      api
        .tables(catalog, s)
        .then(setTables)
        .catch((e) => setError(e.message))
        .finally(() => setTablesLoading(false));
    },
    [catalog, resetTableState],
  );

  const runQuery = useCallback(
    (c: string, s: string, t: string, query: CommittedQuery) => {
      const body: QueryBody = {
        catalog: c,
        schema: s,
        table: t,
        filters: query.filters,
        search: query.search || undefined,
      };
      setPreviewLoading(true);
      setError(null);
      api
        .preview(body)
        .then((res) => {
          setColumns(res.columns);
          setRows(res.rows);
        })
        .catch((e) => {
          setError(e.message);
          setRows([]);
        })
        .finally(() => setPreviewLoading(false));
      setRowCount(null);
      api
        .count(body)
        .then(setRowCount)
        .catch(() => setRowCount(null));
    },
    [],
  );

  const handleSelectTable = useCallback(
    (t: string) => {
      setTable(t);
      resetTableState();
      if (!catalog || !schema) return;
      const empty: CommittedQuery = { filters: [], search: '' };
      setCommitted(empty);
      runQuery(catalog, schema, t, empty);
    },
    [catalog, schema, resetTableState, runQuery],
  );

  // ---- filters ----
  const addFilter = () => {
    const first = columns[0]?.name ?? '';
    setDrafts((d) => [
      ...d,
      { id: filterSeq++, column: first, operator: 'equals', value: '' },
    ]);
  };
  const updateFilter = (id: number, patch: Partial<DraftFilter>) =>
    setDrafts((d) => d.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const removeFilter = (id: number) => setDrafts((d) => d.filter((f) => f.id !== id));

  const applyFilters = useCallback(() => {
    if (!catalog || !schema || !table) return;
    const cleaned = drafts
      .filter((f) => f.column && f.operator)
      .filter((f) => !operatorNeedsValue(f.operator) || f.value.trim() !== '')
      .map((f) => ({
        column: f.column,
        operator: f.operator,
        value: operatorNeedsValue(f.operator) ? f.value : undefined,
      }));
    const query: CommittedQuery = { filters: cleaned, search };
    setCommitted(query);
    runQuery(catalog, schema, table, query);
  }, [catalog, schema, table, drafts, search, runQuery]);

  // ---- export ----
  const exportBody: QueryBody | null = useMemo(() => {
    if (!catalog || !schema || !table) return null;
    return {
      catalog,
      schema,
      table,
      filters: committed.filters,
      search: committed.search || undefined,
      columns: exportCols.length ? exportCols : undefined,
    };
  }, [catalog, schema, table, committed, exportCols]);

  const downloadFile = (id: string) => {
    const a = document.createElement('a');
    a.href = exportFileUrl(id);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const startDownload = useCallback(
    async (format: 'csv' | 'xlsx') => {
      if (!exportBody) return;
      const runId = ++exportRunRef.current;
      setError(null);
      setExportJob({ format, state: 'building', rowCount: 0 });
      try {
        const id = await startExport(format, exportBody);
        for (;;) {
          await sleep(900);
          if (exportRunRef.current !== runId) return; // superseded / reset
          const st = await exportStatus(id);
          if (exportRunRef.current !== runId) return;
          setExportJob({ format, state: st.state, rowCount: st.rowCount });
          if (st.state === 'ready') {
            downloadFile(id);
            setTimeout(() => {
              if (exportRunRef.current === runId) setExportJob(null);
            }, 2500);
            return;
          }
          if (st.state === 'error') {
            setError(st.error ?? 'Falha ao gerar o arquivo de exportação.');
            setExportJob(null);
            return;
          }
        }
      } catch (e) {
        if (exportRunRef.current !== runId) return;
        setError(e instanceof Error ? e.message : 'Falha na exportação');
        setExportJob(null);
      }
    },
    [exportBody],
  );

  const handleDownload = (format: 'csv' | 'xlsx') => {
    if (!exportBody || exportJob?.state === 'building') return;
    if (format === 'xlsx' && rowCount !== null && rowCount > EXCEL_MAX_DATA_ROWS) {
      setTruncateOpen(true);
      return;
    }
    void startDownload(format);
  };

  const toggleExportCol = (name: string) =>
    setExportCols((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name],
    );

  const hasTable = Boolean(catalog && schema && table);
  const fqn = hasTable ? `${catalog}.${schema}.${table}` : '';
  const building = exportJob?.state === 'building';

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex items-center gap-3">
        <Database className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-base font-semibold leading-tight text-foreground">
            Explorador de Catálogo
          </h1>
          <p className="text-xs text-muted-foreground leading-tight">
            Navegue, filtre e exporte dados do Unity Catalog conforme suas permissões
          </p>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6 space-y-4 max-w-[1400px] w-full mx-auto">
        {/* Navigation */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Table2 className="h-4 w-4" /> Selecionar tabela
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Catálogo</Label>
                <SearchableSelect
                  value={catalog}
                  options={catalogs}
                  onChange={handleSelectCatalog}
                  placeholder="Selecione um catálogo"
                  searchPlaceholder="Buscar catálogo…"
                  loading={catalogsLoading}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Schema</Label>
                <SearchableSelect
                  value={schema}
                  options={schemas}
                  onChange={handleSelectSchema}
                  placeholder="Selecione um schema"
                  searchPlaceholder="Buscar schema…"
                  disabled={!catalog}
                  loading={schemasLoading}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Tabela</Label>
                <SearchableSelect
                  value={table}
                  options={tables}
                  onChange={handleSelectTable}
                  placeholder="Selecione uma tabela"
                  searchPlaceholder="Buscar tabela…"
                  disabled={!schema}
                  loading={tablesLoading}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Erro</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!hasTable && !error && (
          <Empty className="border rounded-lg py-16">
            <EmptyMedia variant="icon">
              <Database className="h-6 w-6" />
            </EmptyMedia>
            <EmptyTitle>Nenhuma tabela selecionada</EmptyTitle>
            <EmptyDescription>
              Escolha um catálogo, schema e tabela acima para visualizar e exportar os dados.
            </EmptyDescription>
          </Empty>
        )}

        {hasTable && (
          <>
            {/* Filters */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Filter className="h-4 w-4" /> Filtros
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Busca global (procura o texto em qualquer campo)…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyFilters();
                    }}
                  />
                </div>

                {drafts.map((f) => {
                  const needsValue = operatorNeedsValue(f.operator);
                  return (
                    <div key={f.id} className="flex flex-col sm:flex-row gap-2">
                      <div className="sm:w-56">
                        <Select
                          value={f.column}
                          onValueChange={(v) => updateFilter(f.id, { column: v })}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Coluna" />
                          </SelectTrigger>
                          <SelectContent>
                            {columns.map((c) => (
                              <SelectItem key={c.name} value={c.name}>
                                <span className="truncate">{c.name}</span>
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {c.typeText}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="sm:w-44">
                        <Select
                          value={f.operator}
                          onValueChange={(v) => updateFilter(f.id, { operator: v })}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Operador" />
                          </SelectTrigger>
                          <SelectContent>
                            {OPERATORS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Input
                        className="flex-1"
                        placeholder={needsValue ? 'Valor' : '— sem valor —'}
                        value={f.value}
                        disabled={!needsValue}
                        onChange={(e) => updateFilter(f.id, { value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') applyFilters();
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeFilter(f.id)}
                        aria-label="Remover filtro"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={addFilter}>
                    <Plus className="h-4 w-4 mr-1" /> Adicionar filtro
                  </Button>
                  <Button size="sm" onClick={applyFilters} disabled={previewLoading}>
                    Aplicar
                  </Button>
                  {committed.filters.length > 0 && (
                    <Badge variant="secondary">
                      {committed.filters.length} filtro
                      {committed.filters.length > 1 ? 's' : ''} ativo
                      {committed.filters.length > 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Results */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                  <div className="space-y-1">
                    <CardTitle className="text-sm font-medium font-mono break-all">
                      {fqn}
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">
                        {rowCount === null
                          ? 'Contando…'
                          : `${numberFmt.format(rowCount)} linha${rowCount === 1 ? '' : 's'}`}
                      </Badge>
                      <span>Prévia das primeiras {rows.length} linhas</span>
                      <span>•</span>
                      <span>{columns.length} colunas</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Columns3 className="h-4 w-4 mr-1" />
                          {exportCols.length
                            ? `${exportCols.length} coluna${exportCols.length > 1 ? 's' : ''}`
                            : 'Todas as colunas'}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                        <DropdownMenuLabel>Colunas a exportar</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {columns.map((c) => (
                          <DropdownMenuCheckboxItem
                            key={c.name}
                            checked={exportCols.length === 0 || exportCols.includes(c.name)}
                            onCheckedChange={() => toggleExportCol(c.name)}
                            onSelect={(e) => e.preventDefault()}
                          >
                            {c.name}
                          </DropdownMenuCheckboxItem>
                        ))}
                        {exportCols.length > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <button
                              className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded-sm"
                              onClick={() => setExportCols([])}
                            >
                              Selecionar todas
                            </button>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <Separator orientation="vertical" className="h-6 hidden sm:block" />

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDownload('csv')}
                      disabled={building || previewLoading}
                    >
                      {building && exportJob?.format === 'csv' ? (
                        <Spinner className="h-4 w-4 mr-1" />
                      ) : (
                        <Download className="h-4 w-4 mr-1" />
                      )}
                      CSV
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleDownload('xlsx')}
                      disabled={building || previewLoading}
                    >
                      {building && exportJob?.format === 'xlsx' ? (
                        <Spinner className="h-4 w-4 mr-1" />
                      ) : (
                        <FileSpreadsheet className="h-4 w-4 mr-1" />
                      )}
                      Excel
                    </Button>
                  </div>
                </div>

                <div className="mt-2 text-xs text-muted-foreground">
                  {building ? (
                    <span className="text-foreground">
                      Preparando arquivo {exportJob?.format.toUpperCase()}…{' '}
                      {numberFmt.format(exportJob?.rowCount ?? 0)} linhas gravadas
                    </span>
                  ) : (
                    'O arquivo é gerado no servidor e o download pode ser retomado se a conexão cair.'
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <PreviewTable columns={columns} rows={rows} loading={previewLoading} />
              </CardContent>
            </Card>
          </>
        )}
      </main>

      <AlertDialog open={truncateOpen} onOpenChange={setTruncateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>O arquivo Excel será truncado</AlertDialogTitle>
            <AlertDialogDescription>
              Esta consulta retorna{' '}
              <strong>{rowCount !== null ? numberFmt.format(rowCount) : ''}</strong> linhas, mas
              o formato Excel suporta no máximo{' '}
              {numberFmt.format(EXCEL_MAX_DATA_ROWS + 1)}. Serão exportadas apenas as primeiras{' '}
              {numberFmt.format(EXCEL_MAX_DATA_ROWS)} linhas. Para o resultado completo, use o
              download em CSV. Deseja continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void startDownload('xlsx')}>
              Exportar mesmo assim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PreviewTable({
  columns,
  rows,
  loading,
}: {
  columns: ExplorerColumn[];
  rows: (string | null)[][];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (columns.length === 0) {
    return null;
  }

  if (rows.length === 0) {
    return (
      <Empty className="py-12">
        <EmptyMedia variant="icon">
          <Search className="h-6 w-6" />
        </EmptyMedia>
        <EmptyTitle>Nenhuma linha encontrada</EmptyTitle>
        <EmptyDescription>Ajuste os filtros e tente novamente.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="relative overflow-auto border rounded-md max-h-[60vh]">
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow>
            <TableHead className="w-12 text-right text-muted-foreground">#</TableHead>
            {columns.map((c) => (
              <TableHead key={c.name} className="whitespace-nowrap">
                <div className="font-medium text-foreground">{c.name}</div>
                <div className="text-[10px] font-normal text-muted-foreground uppercase">
                  {c.typeText}
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, ri) => (
            <TableRow key={ri}>
              <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                {ri + 1}
              </TableCell>
              {columns.map((c, ci) => {
                const cell = row[ci];
                return (
                  <TableCell key={c.name} className="max-w-[320px]">
                    {cell === null || cell === undefined ? (
                      <span className="text-muted-foreground italic">null</span>
                    ) : (
                      <span className="block truncate" title={cell}>
                        {cell}
                      </span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
