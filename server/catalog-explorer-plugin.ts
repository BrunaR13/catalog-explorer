import express from 'express';
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

    router.get('/export', (req, res) => {
      void this.handleExport(req, res);
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

  private async handleExport(req: express.Request, res: express.Response): Promise<void> {
    const format = String(req.query.format ?? 'csv').toLowerCase();
    let input: QueryInput | null = null;
    try {
      const raw = Buffer.from(String(req.query.payload ?? ''), 'base64').toString('utf-8');
      input = this.parseQueryInput(JSON.parse(raw));
    } catch {
      input = null;
    }
    if (!input) return void res.status(400).json({ error: 'Invalid payload' });

    const baseName = `${input.catalog}.${input.schema}.${input.table}`.replace(
      /[^A-Za-z0-9._-]/g,
      '_',
    );

    try {
      if (format === 'xlsx') {
        await this.exportXlsx(req, res, input, baseName);
      } else {
        await this.exportCsv(req, res, input, baseName);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed';
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      } else {
        res.end();
      }
    }
  }

  private async exportCsv(
    req: express.Request,
    res: express.Response,
    input: QueryInput,
    baseName: string,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    res.write('\ufeff'); // UTF-8 BOM for Excel compatibility.

    const csvCell = (v: string | null): string => {
      if (v === null || v === undefined) return '';
      const needsQuote = /[",\n\r]/.test(v);
      const escaped = v.replace(/"/g, '""');
      return needsQuote ? `"${escaped}"` : escaped;
    };

    await this.asUser(req).exportRows(input, Number.MAX_SAFE_INTEGER, {
      onStart: (headers) => {
        res.write(headers.map(csvCell).join(',') + '\r\n');
      },
      onRows: (rows) => {
        let buf = '';
        for (const row of rows) {
          buf += row.map(csvCell).join(',') + '\r\n';
        }
        res.write(buf);
      },
    });
    res.end();
  }

  private async exportXlsx(
    req: express.Request,
    res: express.Response,
    input: QueryInput,
    baseName: string,
  ): Promise<void> {
    const ExcelJS = (await import('exceljs')).default;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const sheet = workbook.addWorksheet('data');

    const result = await this.asUser(req).exportRows(input, EXCEL_MAX_DATA_ROWS, {
      onStart: (headers) => {
        sheet.addRow(headers).commit();
      },
      onRows: (rows) => {
        for (const row of rows) {
          sheet.addRow(row.map((v) => (v === null ? '' : v))).commit();
        }
      },
    });
    void result;
    await workbook.commit();
  }
}

export const catalogExplorer = toPlugin(CatalogExplorerPlugin);
