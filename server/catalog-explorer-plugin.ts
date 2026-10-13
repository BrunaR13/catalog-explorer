import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  Plugin,
  toPlugin,
  getExecutionContext,
  ResourceType,
  type PluginManifest,
} from '@databricks/appkit';

/**
 * Catalog Explorer plugin.
 *
 * Lets the signed-in user browse Unity Catalog (catalogs → schemas → tables),
 * preview rows, filter by any field, and export the full filtered result as
 * CSV or Excel. Every operation runs on-behalf-of the request user
 * (`this.asUser(req)`), so Unity Catalog permissions are enforced per user.
 *
 * SQL is executed through the Databricks SQL Statement Execution API with the
 * INLINE/JSON_ARRAY disposition (the only disposition reachable from the app
 * sandbox). Identifiers are validated against the live table schema and
 * backtick-escaped; filter values are always bound as parameters.
 */

const EXCEL_MAX_DATA_ROWS = 1_048_575; // 1,048,576 incl. header row.
const PREVIEW_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 25_000;
const MIN_PAGE_SIZE = 500;
const JOB_TTL_MS = 60 * 60 * 1000; // keep built export files for 1 hour

type ExportFormat = 'csv' | 'xlsx';

interface ExportJob {
  id: string;
  owner: string;
  format: ExportFormat;
  baseName: string;
  filePath: string;
  state: 'building' | 'ready' | 'error';
  rowCount: number;
  truncated: boolean;
  bytes: number;
  error?: string;
  createdAt: number;
}

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

export interface QueryInput {
  catalog: string;
  schema: string;
  table: string;
  filters?: ExplorerFilter[];
  search?: string;
  columns?: string[];
}

interface SqlParam {
  name: string;
  type?: string;
  value?: string;
}

const COMPLEX_TYPES = new Set(['ARRAY', 'MAP', 'STRUCT', 'VARIANT']);
const COMPARISON_OPS: Record<string, string> = {
  equals: '=',
  not_equals: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

function qualifiedTable(catalog: string, schema: string, table: string): string {
  return `${quoteIdent(catalog)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** Escape LIKE wildcards so the user value is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function isComplex(col: ExplorerColumn): boolean {
  return COMPLEX_TYPES.has((col.typeName || '').toUpperCase());
}

/** Map a Unity Catalog column type to a SQL type usable for a bound parameter. */
function paramType(col: ExplorerColumn): string {
  const t = (col.typeName || '').toUpperCase();
  switch (t) {
    case 'LONG':
      return 'BIGINT';
    case 'SHORT':
      return 'SMALLINT';
    case 'BYTE':
      return 'TINYINT';
    case 'INT':
      return 'INT';
    case 'FLOAT':
      return 'FLOAT';
    case 'DOUBLE':
      return 'DOUBLE';
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'DATE':
      return 'DATE';
    case 'TIMESTAMP':
      return 'TIMESTAMP';
    case 'TIMESTAMP_NTZ':
      return 'TIMESTAMP_NTZ';
    case 'DECIMAL':
      return (col.typeText || 'DECIMAL(38,18)').toUpperCase();
    default:
      return 'STRING';
  }
}

const manifest = {
  name: 'catalogExplorer',
  displayName: 'Catalog Explorer',
  description:
    'Browse Unity Catalog, preview and filter tables, and export results as CSV or Excel.',
  resources: {
    required: [
      {
        type: ResourceType.SQL_WAREHOUSE,
        alias: 'SQL Warehouse',
        resourceKey: 'sql-warehouse',
        description: 'SQL Warehouse used to read and export table data',
        permission: 'CAN_USE',
        fields: {
          id: {
            env: 'DATABRICKS_WAREHOUSE_ID',
            description: 'SQL Warehouse ID',
          },
        },
      },
    ],
    optional: [],
  },
} satisfies PluginManifest<'catalogExplorer'>;

class CatalogExplorerPlugin extends Plugin {
  static manifest = manifest;

  /** In-memory registry of export jobs, keyed by job id. */
  private jobs = new Map<string, ExportJob>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  async setup(): Promise<void> {
    this.cleanupTimer = setInterval(() => this.sweepJobs(), 10 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) this.safeUnlink(job.filePath);
    this.jobs.clear();
  }

  private sweepJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (now - job.createdAt > JOB_TTL_MS) {
        this.safeUnlink(job.filePath);
        this.jobs.delete(id);
      }
    }
  }

  private safeUnlink(p: string): void {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  }

  private ownsJob(req: express.Request, job: ExportJob): boolean {
    const user = String(req.headers['x-forwarded-user'] ?? '');
    // When identity headers are absent (local dev) ownership is not enforced.
    if (!job.owner || !user) return true;
    return job.owner === user;
  }

  // ---- low level execution -------------------------------------------------

  private async resolveWarehouseId(): Promise<string> {
    const ctx = getExecutionContext();
    const fromCtx = ctx.warehouseId ? await ctx.warehouseId : undefined;
    const id = fromCtx || process.env.DATABRICKS_WAREHOUSE_ID;
    if (!id) {
      throw new Error('DATABRICKS_WAREHOUSE_ID is not configured');
    }
    return id;
  }

  /** Run a statement and collect every result chunk (INLINE/JSON_ARRAY). */
  private async runStatement(
    statement: string,
    parameters: SqlParam[] = [],
  ): Promise<{ columns: ExplorerColumn[]; rows: string[][] }> {
    const client = getExecutionContext().client;
    const warehouseId = await this.resolveWarehouseId();
    const exec = client.statementExecution;

    let resp = await exec.executeStatement({
      warehouse_id: warehouseId,
      statement,
      parameters: parameters.length ? parameters : undefined,
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      wait_timeout: '30s',
      on_wait_timeout: 'CONTINUE',
    });

    const statementId = resp.statement_id;
    let state = resp.status?.state;
    const started = Date.now();
    while (state === 'PENDING' || state === 'RUNNING') {
      if (Date.now() - started > 290_000) {
        throw new Error('Query timed out');
      }
      await new Promise((r) => setTimeout(r, 1000));
      resp = await exec.getStatement({ statement_id: statementId });
      state = resp.status?.state;
    }

    if (state !== 'SUCCEEDED') {
      const msg = resp.status?.error?.message || `Query ${state ?? 'failed'}`;
      throw new Error(msg);
    }

    const columns: ExplorerColumn[] = (resp.manifest?.schema?.columns ?? []).map((c) => ({
      name: c.name ?? '',
      typeName: String(c.type_name ?? ''),
      typeText: c.type_text ?? '',
    }));

    let rows: string[][] = resp.result?.data_array ?? [];
    let next = resp.result?.next_chunk_index;
    while (next !== undefined && next !== null) {
      const chunk = await exec.getStatementResultChunkN({
        statement_id: statementId,
        chunk_index: next,
      });
      rows = rows.concat(chunk.data_array ?? []);
      next = chunk.next_chunk_index;
    }

    return { columns, rows };
  }

  // ---- browsing ------------------------------------------------------------

  async listCatalogs(): Promise<string[]> {
    const { rows } = await this.runStatement('SHOW CATALOGS');
    return rows.map((r) => r[0]).filter((v): v is string => !!v).sort();
  }

  async listSchemas(catalog: string): Promise<string[]> {
    const { rows } = await this.runStatement(`SHOW SCHEMAS IN ${quoteIdent(catalog)}`);
    return rows.map((r) => r[0]).filter((v): v is string => !!v).sort();
  }

  async listTables(catalog: string, schema: string): Promise<string[]> {
    const { rows } = await this.runStatement(
      `SHOW TABLES IN ${quoteIdent(catalog)}.${quoteIdent(schema)}`,
    );
    // SHOW TABLES columns: database, tableName, isTemporary
    return rows.map((r) => r[1]).filter((v): v is string => !!v).sort();
  }

  async getColumns(ref: QueryInput): Promise<ExplorerColumn[]> {
    const qt = qualifiedTable(ref.catalog, ref.schema, ref.table);
    const { columns } = await this.runStatement(`SELECT * FROM ${qt} LIMIT 0`);
    return columns;
  }

  // ---- query building ------------------------------------------------------

  private buildWhere(
    columns: ExplorerColumn[],
    filters: ExplorerFilter[],
    search: string | undefined,
  ): { clause: string; params: SqlParam[] } {
    const byName = new Map(columns.map((c) => [c.name, c]));
    const conds: string[] = [];
    const params: SqlParam[] = [];
    let i = 0;

    for (const f of filters) {
      const col = byName.get(f.column);
      if (!col) throw new Error(`Unknown column: ${f.column}`);
      const id = quoteIdent(col.name);
      const op = f.operator;

      if (op === 'is_null') {
        conds.push(`${id} IS NULL`);
        continue;
      }
      if (op === 'is_not_null') {
        conds.push(`${id} IS NOT NULL`);
        continue;
      }

      const value = f.value ?? '';
      const pName = `p${i++}`;

      if (op === 'contains' || op === 'starts_with' || op === 'ends_with') {
        const esc = escapeLike(value);
        const pattern =
          op === 'contains' ? `%${esc}%` : op === 'starts_with' ? `${esc}%` : `%${esc}`;
        params.push({ name: pName, type: 'STRING', value: pattern });
        conds.push(`CAST(${id} AS STRING) LIKE :${pName} ESCAPE '\\\\'`);
        continue;
      }

      const symbol = COMPARISON_OPS[op];
      if (!symbol) throw new Error(`Unsupported operator: ${op}`);
      if (isComplex(col)) {
        throw new Error(`Operator "${op}" is not supported on complex column ${col.name}`);
      }
      params.push({ name: pName, type: paramType(col), value });
      conds.push(`${id} ${symbol} :${pName}`);
    }

    if (search && search.trim() !== '') {
      params.push({ name: 'g', type: 'STRING', value: `%${escapeLike(search)}%` });
      const ors = columns.map(
        (c) => `CAST(${quoteIdent(c.name)} AS STRING) ILIKE :g ESCAPE '\\\\'`,
      );
      if (ors.length) conds.push(`(${ors.join(' OR ')})`);
    }

    return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  private resolveSelected(columns: ExplorerColumn[], selected?: string[]): ExplorerColumn[] {
    if (!selected || selected.length === 0) return columns;
    const byName = new Map(columns.map((c) => [c.name, c]));
    const out: ExplorerColumn[] = [];
    for (const name of selected) {
      const col = byName.get(name);
      if (col) out.push(col);
    }
    return out.length ? out : columns;
  }

  // ---- preview + count -----------------------------------------------------

  async preview(
    input: QueryInput,
  ): Promise<{ columns: ExplorerColumn[]; rows: string[][] }> {
    const columns = await this.getColumns(input);
    const { clause, params } = this.buildWhere(columns, input.filters ?? [], input.search);
    const qt = qualifiedTable(input.catalog, input.schema, input.table);
    const { rows } = await this.runStatement(
      `SELECT * FROM ${qt} ${clause} LIMIT ${PREVIEW_LIMIT}`,
      params,
    );
    return { columns, rows };
  }

  async count(input: QueryInput): Promise<number> {
    const columns = await this.getColumns(input);
    const { clause, params } = this.buildWhere(columns, input.filters ?? [], input.search);
    const qt = qualifiedTable(input.catalog, input.schema, input.table);
    const { rows } = await this.runStatement(
      `SELECT COUNT(*) AS cnt FROM ${qt} ${clause}`,
      params,
    );
    return Number(rows[0]?.[0] ?? 0);
  }

  // ---- export (paginated streaming) ---------------------------------------

  async exportRows(
    input: QueryInput,
    maxRows: number,
    handlers: {
      onStart: (headers: string[]) => Promise<void> | void;
      onRows: (rows: string[][]) => Promise<void> | void;
    },
  ): Promise<{ rowCount: number; truncated: boolean }> {
    const columns = await this.getColumns(input);
    const selected = this.resolveSelected(columns, input.columns);
    const { clause, params } = this.buildWhere(columns, input.filters ?? [], input.search);
    const qt = qualifiedTable(input.catalog, input.schema, input.table);

    const selectList = selected.map((c) => quoteIdent(c.name)).join(', ');
    const scalarCols = columns.filter((c) => !isComplex(c));

    await handlers.onStart(selected.map((c) => c.name));

    const bounded = maxRows < Number.MAX_SAFE_INTEGER;
    const limitClause = bounded ? `LIMIT ${maxRows}` : '';

    // Fast path: one statement, streamed chunk by chunk, with no ORDER BY so
    // the warehouse scans once without sorting. This handles everything that
    // fits in the 25 MiB INLINE ceiling — the common case — as a single query.
    const fast = await this.streamSingle(
      `SELECT ${selectList} FROM ${qt} ${clause} ${limitClause}`,
      params,
      handlers.onRows,
    );
    if (fast.ok) {
      return { rowCount: fast.rowCount, truncated: bounded && fast.rowCount >= maxRows };
    }

    // Fallback (result exceeds the INLINE ceiling): page through the result.
    // A stable ORDER BY over every scalar column keeps pages consistent across
    // separate statements; without an orderable column we cannot paginate.
    if (scalarCols.length === 0) {
      throw new Error(
        'O resultado é grande demais para exportar e a tabela não tem colunas ordenáveis para paginar. Refine os filtros.',
      );
    }
    const orderBy = `ORDER BY ${scalarCols.map((c) => quoteIdent(c.name)).join(', ')}`;

    let total = 0;
    let truncated = false;
    let pageSize = DEFAULT_PAGE_SIZE;
    let offset = 0;

    for (;;) {
      const remaining = maxRows - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const lim = Math.min(pageSize, remaining);
      const stmt = `SELECT ${selectList} FROM ${qt} ${clause} ${orderBy} LIMIT ${lim} OFFSET ${offset}`;

      let rows: string[][];
      try {
        rows = (await this.runStatement(stmt, params)).rows;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/inline byte limit/i.test(msg) && pageSize > MIN_PAGE_SIZE) {
          pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
          continue; // retry same offset with a smaller page
        }
        throw err;
      }

      if (rows.length > 0) {
        await handlers.onRows(rows);
        total += rows.length;
        offset += rows.length;
      }
      if (rows.length < lim) break; // last page
    }

    return { rowCount: total, truncated };
  }

  /**
   * Execute one statement and stream each INLINE result chunk to `onRows` as it
   * arrives (no buffering of the whole result). Returns `{ ok: false }` when the
   * result overflows the 25 MiB INLINE ceiling, so the caller can fall back to
   * paginated fetching; any other failure is thrown.
   */
  private async streamSingle(
    statement: string,
    parameters: SqlParam[],
    onRows: (rows: string[][]) => Promise<void> | void,
  ): Promise<{ ok: true; rowCount: number } | { ok: false }> {
    const client = getExecutionContext().client;
    const warehouseId = await this.resolveWarehouseId();
    const exec = client.statementExecution;
    const isOverflow = (msg: string) => /inline byte limit/i.test(msg);

    let resp: Awaited<ReturnType<typeof exec.executeStatement>>;
    try {
      resp = await exec.executeStatement({
        warehouse_id: warehouseId,
        statement,
        parameters: parameters.length ? parameters : undefined,
        disposition: 'INLINE',
        format: 'JSON_ARRAY',
        wait_timeout: '30s',
        on_wait_timeout: 'CONTINUE',
      });
    } catch (err) {
      if (err instanceof Error && isOverflow(err.message)) return { ok: false };
      throw err;
    }

    const statementId = resp.statement_id;
    let state = resp.status?.state;
    const started = Date.now();
    while (state === 'PENDING' || state === 'RUNNING') {
      if (Date.now() - started > 290_000) throw new Error('Query timed out');
      await new Promise((r) => setTimeout(r, 1000));
      resp = await exec.getStatement({ statement_id: statementId });
      state = resp.status?.state;
    }

    if (state !== 'SUCCEEDED') {
      const msg = resp.status?.error?.message || `Query ${state ?? 'failed'}`;
      if (isOverflow(msg)) return { ok: false };
      throw new Error(msg);
    }

    let total = 0;
    const first = resp.result?.data_array ?? [];
    if (first.length) {
      await onRows(first);
      total += first.length;
    }
    let next = resp.result?.next_chunk_index;
    while (next !== undefined && next !== null) {
      const chunk = await exec.getStatementResultChunkN({
        statement_id: statementId,
        chunk_index: next,
      });
      const data = chunk.data_array ?? [];
      if (data.length) {
        await onRows(data);
        total += data.length;
      }
      next = chunk.next_chunk_index;
    }

    return { ok: true, rowCount: total };
  }

  // ---- routes --------------------------------------------------------------

  injectRoutes(router: express.Router): void {
    const asJson = express.json({ limit: '2mb' });

    router.get('/catalogs', (req, res) => {
      void this.handle(res, () => this.asUser(req).listCatalogs().then((catalogs) => ({ catalogs })));
    });

    router.get('/schemas', (req, res) => {
      const catalog = String(req.query.catalog ?? '');
      if (!catalog) return void res.status(400).json({ error: 'catalog is required' });
      void this.handle(res, () =>
        this.asUser(req).listSchemas(catalog).then((schemas) => ({ schemas })),
      );
    });

    router.get('/tables', (req, res) => {
      const catalog = String(req.query.catalog ?? '');
      const schema = String(req.query.schema ?? '');
      if (!catalog || !schema)
        return void res.status(400).json({ error: 'catalog and schema are required' });
      void this.handle(res, () =>
        this.asUser(req).listTables(catalog, schema).then((tables) => ({ tables })),
      );
    });

    router.post('/preview', asJson, (req, res) => {
      const input = this.parseQueryInput(req.body);
      if (!input) return void res.status(400).json({ error: 'Invalid request' });
      void this.handle(res, () => this.asUser(req).preview(input));
    });

    router.post('/count', asJson, (req, res) => {
      const input = this.parseQueryInput(req.body);
      if (!input) return void res.status(400).json({ error: 'Invalid request' });
      void this.handle(res, () => this.asUser(req).count(input).then((count) => ({ count })));
    });

    // Start an export: builds the file server-side, returns a job id. The
    // build keeps running in the user's OBO context even after this handler
    // responds (AsyncLocalStorage follows the async chain).
    router.post('/export/start', asJson, (req, res) => {
      const input = this.parseQueryInput(req.body);
      if (!input) return void res.status(400).json({ error: 'Invalid request' });
      const body = req.body as { format?: unknown };
      const format: ExportFormat = body.format === 'xlsx' ? 'xlsx' : 'csv';
      const id = randomUUID();
      const baseName = `${input.catalog}.${input.schema}.${input.table}`.replace(
        /[^A-Za-z0-9._-]/g,
        '_',
      );
      const job: ExportJob = {
        id,
        owner: String(req.headers['x-forwarded-user'] ?? ''),
        format,
        baseName,
        filePath: path.join(os.tmpdir(), `catalog-export-${id}.${format}`),
        state: 'building',
        rowCount: 0,
        truncated: false,
        bytes: 0,
        createdAt: Date.now(),
      };
      this.jobs.set(id, job);
      const maxRows = format === 'xlsx' ? EXCEL_MAX_DATA_ROWS : Number.MAX_SAFE_INTEGER;
      void this.asUser(req)
        .buildExport(id, input, format, maxRows)
        .catch((err: unknown) => {
          job.state = 'error';
          job.error = err instanceof Error ? err.message : 'Falha na exportação';
          this.safeUnlink(job.filePath);
        });
      res.json({ id });
    });

    router.get('/export/:id/status', (req, res) => {
      const job = this.jobs.get(req.params.id);
      if (!job) return void res.status(404).json({ error: 'Export não encontrado' });
      if (!this.ownsJob(req, job))
        return void res.status(403).json({ error: 'Sem acesso a este export' });
      res.json({
        state: job.state,
        rowCount: job.rowCount,
        truncated: job.truncated,
        bytes: job.bytes,
        error: job.error,
      });
    });

    // Resumable download: res.download → sendFile, which honors HTTP Range
    // requests plus ETag/Last-Modified, so an interrupted transfer can resume
    // from where it stopped instead of restarting the whole export.
    router.get('/export/:id/file', (req, res) => {
      const job = this.jobs.get(req.params.id);
      if (!job) return void res.status(404).json({ error: 'Export não encontrado' });
      if (!this.ownsJob(req, job))
        return void res.status(403).json({ error: 'Sem acesso a este export' });
      if (job.state !== 'ready')
        return void res.status(409).json({ error: 'Export ainda não está pronto' });
      const contentType =
        job.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8';
      res.download(job.filePath, `${job.baseName}.${job.format}`, {
        headers: { 'Content-Type': contentType },
      });
    });
  }

  private parseQueryInput(body: unknown): QueryInput | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (
      typeof b.catalog !== 'string' ||
      typeof b.schema !== 'string' ||
      typeof b.table !== 'string'
    )
      return null;
    const filters: ExplorerFilter[] = Array.isArray(b.filters)
      ? b.filters
          .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
          .map((f) => ({
            column: String(f.column ?? ''),
            operator: String(f.operator ?? ''),
            value: f.value === undefined ? undefined : String(f.value),
          }))
          .filter((f) => f.column && f.operator)
      : [];
    const columns = Array.isArray(b.columns)
      ? b.columns.map((c) => String(c)).filter((c) => c)
      : undefined;
    return {
      catalog: b.catalog,
      schema: b.schema,
      table: b.table,
      filters,
      search: typeof b.search === 'string' ? b.search : undefined,
      columns,
    };
  }

  private async handle(
    res: express.Response,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      const data = await fn();
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * Build an export file on disk (runs inside the user's OBO context). Writes
   * are streamed to disk so memory stays flat regardless of result size, and
   * `job.rowCount` is updated as rows land so the client can show progress.
   */
  async buildExport(
    jobId: string,
    input: QueryInput,
    format: ExportFormat,
    maxRows: number,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (format === 'xlsx') {
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: job.filePath });
      const sheet = workbook.addWorksheet('data');
      const result = await this.exportRows(input, maxRows, {
        onStart: (headers) => {
          sheet.addRow(headers).commit();
        },
        onRows: (rows) => {
          for (const row of rows) {
            sheet.addRow(row.map((v) => (v === null ? '' : v))).commit();
          }
          job.rowCount += rows.length;
        },
      });
      await workbook.commit();
      job.rowCount = result.rowCount;
      job.truncated = result.truncated;
    } else {
      const out = fs.createWriteStream(job.filePath);
      let streamErr: Error | null = null;
      out.on('error', (e) => {
        streamErr = e;
      });
      const write = async (s: string): Promise<void> => {
        if (streamErr) throw streamErr;
        if (!out.write(s)) await once(out, 'drain');
      };
      const csvCell = (v: string | null): string => {
        if (v === null || v === undefined) return '';
        const needsQuote = /[",\n\r]/.test(v);
        return needsQuote ? `"${v.replace(/"/g, '""')}"` : v;
      };

      await write('\ufeff'); // UTF-8 BOM for Excel compatibility.
      const result = await this.exportRows(input, maxRows, {
        onStart: async (headers) => {
          await write(headers.map(csvCell).join(',') + '\r\n');
        },
        onRows: async (rows) => {
          let buf = '';
          for (const row of rows) buf += row.map(csvCell).join(',') + '\r\n';
          await write(buf);
          job.rowCount += rows.length;
        },
      });
      out.end();
      await once(out, 'finish');
      job.rowCount = result.rowCount;
      job.truncated = result.truncated;
    }

    job.bytes = fs.statSync(job.filePath).size;
    job.state = 'ready';
  }
}

export const catalogExplorer = toPlugin(CatalogExplorerPlugin);
