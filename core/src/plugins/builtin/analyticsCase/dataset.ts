/**
 * `tabular-dataset` artifact 契约。
 *
 * 这份数据最终要进 Prompt，所以契约的重点不是「能读多大的表」，而是「读进来的东西
 * 必须是可如实描述的」：
 * - 体量有硬上限，超了就截断并把截断这件事记在数据里，不让 Prompt 以为自己看到了全表；
 * - 列类型在解析期一次推断完，评分侧和模型看到的是同一套类型，不各自猜；
 * - 推断只认无歧义的写法。`12%`、`$1,200`、`0/1` 一律留成文本，因为把它们当成
 *   数字会悄悄改变分析结论，而分析结论是这个能力的全部产出。
 *
 * 解析分两层：`parseDelimitedText` 只负责把文本切成网格，`buildTabularDataset`
 * 负责校验与类型推断。XLSX 与 CSV 共用后者，差别只在谁把工作表变成网格。
 */

export const TABULAR_DATASET_ARTIFACT_TYPE = 'tabular-dataset';
export const TABULAR_DATASET_SCHEMA_VERSION = 1;

/** artifact 可能的来源格式；两者共用同一套 dataset 结构。 */
export const TABULAR_SOURCE_FORMATS = ['csv', 'xlsx'] as const;
export type TabularSourceFormat = (typeof TABULAR_SOURCE_FORMATS)[number];

export const TABULAR_COLUMN_TYPES = ['text', 'number', 'date', 'boolean'] as const;
export type TabularColumnType = (typeof TABULAR_COLUMN_TYPES)[number];

export type TabularCell = string | number | boolean | null;

export const TABULAR_DATASET_LIMITS = {
  maxColumns: 64,
  maxRows: 2000,
  maxCellChars: 1000,
} as const;

export interface TabularColumn {
  name: string;
  type: TabularColumnType;
  /** 空值数量；概览要用，解析时顺手算完，免得后面为一句话再扫一遍全表。 */
  missingCount: number;
}

export interface TabularDataset {
  schemaVersion: number;
  sourceFormat: TabularSourceFormat;
  columns: TabularColumn[];
  rows: TabularCell[][];
  /** 截断前的真实行数。 */
  totalRows: number;
  /** 行数超过上限被截断。 */
  truncated: boolean;
  /** 被截短的单元格数量；长文本列（比如用户反馈原文）会命中。 */
  truncatedCells: number;
}

export type TabularParseErrorCode =
  | 'empty-source'
  | 'blank-column-name'
  | 'duplicate-column-name'
  | 'too-many-columns'
  | 'ragged-row'
  | 'unclosed-quote';

export type TabularParseResult =
  | { ok: true; dataset: TabularDataset }
  | { ok: false; code: TabularParseErrorCode; message: string };

function fail(code: TabularParseErrorCode, message: string): TabularParseResult {
  return { ok: false, code, message };
}

/**
 * 把分隔符文本切成网格。
 *
 * 按 RFC 4180 处理引号：引号内可含分隔符与换行，`""` 表示一个字面引号。
 * 不做类型推断，也不做行宽校验，那些属于 `buildTabularDataset`。
 */
export function parseDelimitedText(
  source: string,
  delimiter = ',',
): { ok: true; grid: string[][] } | { ok: false; code: TabularParseErrorCode; message: string } {
  // BOM 会粘在第一个列名上，让后续按列名取值全部落空。
  const text = source.replace(/^\uFEFF/, '');
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let cellStarted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
      continue;
    }

    if (char === delimiter) {
      row.push(cell);
      cell = '';
      cellStarted = false;
      continue;
    }

    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      grid.push(row);
      row = [];
      cell = '';
      cellStarted = false;
      continue;
    }

    cell += char;
    cellStarted = true;
  }

  if (quoted) {
    return {
      ok: false,
      code: 'unclosed-quote',
      message: '引号没有闭合，无法确定表格边界。',
    };
  }

  // 末尾没有换行时最后一格还在手上；有换行时不要凭空补一个空行。
  if (cell !== '' || cellStarted || row.length > 0) {
    row.push(cell);
    grid.push(row);
  }

  return { ok: true, grid };
}

const DATE_PATTERN = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;
const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE_LITERALS = new Set(['true', 'yes']);
const FALSE_LITERALS = new Set(['false', 'no']);

function isNumberLiteral(value: string): boolean {
  return NUMBER_PATTERN.test(value) && Number.isFinite(Number(value));
}

/** 只认 ISO 风格且日历上真实存在的日期；`2025-02-30` 不算日期。 */
function normalizeDateLiteral(value: string): string | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCFullYear() !== Number(year)) return null;
  if (parsed.getUTCMonth() + 1 !== Number(month)) return null;
  if (parsed.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function booleanLiteral(value: string): boolean | null {
  const lowered = value.toLowerCase();
  if (TRUE_LITERALS.has(lowered)) return true;
  if (FALSE_LITERALS.has(lowered)) return false;
  return null;
}

/**
 * 推断一列的类型。
 *
 * 全列非空值都符合某个类型才采用该类型；只要有一个不符合就退回 text。
 * 整列为空时也是 text——空列没有可推断的信息，假装它是数字会让后面的
 * 指标分析建立在一个不存在的前提上。
 */
function inferColumnType(values: readonly string[]): TabularColumnType {
  const present = values.filter((value) => value !== '');
  if (present.length === 0) return 'text';
  if (present.every(isNumberLiteral)) return 'number';
  if (present.every((value) => normalizeDateLiteral(value) !== null)) return 'date';
  if (present.every((value) => booleanLiteral(value) !== null)) return 'boolean';
  return 'text';
}

function coerceCell(value: string, type: TabularColumnType): TabularCell {
  if (value === '') return null;
  switch (type) {
    case 'number':
      return Number(value);
    case 'date':
      return normalizeDateLiteral(value);
    case 'boolean':
      return booleanLiteral(value);
    case 'text':
      return value;
  }
}

export interface BuildTabularDatasetInput {
  sourceFormat: TabularSourceFormat;
  /** 第一行是表头，其余为数据行。 */
  grid: readonly (readonly string[])[];
}

/**
 * 校验网格并推断类型，产出 artifact。
 *
 * CSV 与 XLSX 都走这里，保证两种来源产出的 dataset 结构与类型判断完全一致。
 */
export function buildTabularDataset(input: BuildTabularDatasetInput): TabularParseResult {
  const { grid, sourceFormat } = input;
  // 整行为空的行跳过（导出的文件常有零散空行），但行号必须留住原始位置，
  // 否则报错信息里的「第 N 行」指不到用户在编辑器里看到的那一行。
  const meaningful = grid
    .map((row, index) => ({ row, lineNumber: index + 1 }))
    .filter((entry) => entry.row.some((cell) => cell.trim() !== ''));
  const header = meaningful[0]?.row;
  if (!header || header.length === 0) {
    return fail('empty-source', '文件里没有可读的表头。');
  }

  if (header.length > TABULAR_DATASET_LIMITS.maxColumns) {
    return fail(
      'too-many-columns',
      `列数 ${header.length} 超过上限 ${TABULAR_DATASET_LIMITS.maxColumns}。`,
    );
  }

  const names = header.map((name) => name.trim());
  const blankAt = names.findIndex((name) => name === '');
  if (blankAt >= 0) {
    return fail('blank-column-name', `第 ${blankAt + 1} 列没有列名。`);
  }
  const seen = new Set<string>();
  for (const name of names) {
    // 重名列会让「引用了哪一列」变得无法判定，而分析输出全靠列名定位事实。
    if (seen.has(name)) return fail('duplicate-column-name', `列名 ${name} 重复。`);
    seen.add(name);
  }

  const bodyRows = meaningful.slice(1);
  for (const entry of bodyRows) {
    const width = entry.row.length;
    if (width !== names.length) {
      // 补齐或丢弃都会悄悄改变数据；在分析工具里这是最不该发生的事。
      return fail(
        'ragged-row',
        `第 ${entry.lineNumber} 行有 ${width} 个单元格，与 ${names.length} 列不匹配。`,
      );
    }
  }

  const totalRows = bodyRows.length;
  const kept = bodyRows.slice(0, TABULAR_DATASET_LIMITS.maxRows).map((entry) => entry.row);

  let truncatedCells = 0;
  const cells = kept.map((row) =>
    row.map((cell) => {
      const trimmed = cell.trim();
      if (trimmed.length <= TABULAR_DATASET_LIMITS.maxCellChars) return trimmed;
      truncatedCells += 1;
      return trimmed.slice(0, TABULAR_DATASET_LIMITS.maxCellChars);
    }),
  );

  const columns: TabularColumn[] = names.map((name, columnIndex) => {
    const values = cells.map((row) => row[columnIndex]);
    return {
      name,
      type: inferColumnType(values),
      missingCount: values.filter((value) => value === '').length,
    };
  });

  const rows = cells.map((row) =>
    row.map((value, columnIndex) => coerceCell(value, columns[columnIndex].type)),
  );

  return {
    ok: true,
    dataset: {
      schemaVersion: TABULAR_DATASET_SCHEMA_VERSION,
      sourceFormat,
      columns,
      rows,
      totalRows,
      truncated: totalRows > kept.length,
      truncatedCells,
    },
  };
}

/** CSV 文本 → artifact。 */
export function parseCsvArtifact(source: string, delimiter = ','): TabularParseResult {
  const parsed = parseDelimitedText(source, delimiter);
  if (!parsed.ok) return parsed;
  return buildTabularDataset({ sourceFormat: 'csv', grid: parsed.grid });
}

export function findColumn(
  dataset: TabularDataset,
  name: string,
): { column: TabularColumn; index: number } | null {
  const index = dataset.columns.findIndex((column) => column.name === name);
  if (index < 0) return null;
  return { column: dataset.columns[index], index };
}

/** 取某列的数值；非数值列返回空数组，调用方因此无法把文本列当指标算。 */
export function numericValues(dataset: TabularDataset, name: string): number[] {
  const found = findColumn(dataset, name);
  if (!found || found.column.type !== 'number') return [];
  return dataset.rows
    .map((row) => row[found.index])
    .filter((value): value is number => typeof value === 'number');
}
