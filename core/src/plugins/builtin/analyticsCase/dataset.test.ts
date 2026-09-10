/**
 * tabular-dataset 解析边界。
 *
 * 重点不是「能不能读」，而是「读错时会不会不声不响」：类型推断上的每一次
 * 好心猜测、每一次替用户补齐残行，都会变成一条建立在假前提上的分析结论。
 */
import { describe, expect, it } from 'vitest';

import {
  TABULAR_DATASET_LIMITS,
  TABULAR_DATASET_SCHEMA_VERSION,
  buildTabularDataset,
  findColumn,
  numericValues,
  parseCsvArtifact,
  parseDelimitedText,
} from './dataset';

function parse(csv: string) {
  const result = parseCsvArtifact(csv);
  if (!result.ok) throw new Error(`解析本应成功，却得到 ${result.code}: ${result.message}`);
  return result.dataset;
}

describe('分隔符文本切分', () => {
  it('引号内的分隔符与换行都属于同一个单元格', () => {
    const parsed = parseDelimitedText('a,b\n"x,1","line1\nline2"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grid).toEqual([
      ['a', 'b'],
      ['x,1', 'line1\nline2'],
    ]);
  });

  it('两个连续引号表示一个字面引号', () => {
    const parsed = parseDelimitedText('note\n"她说""好"""');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grid[1]).toEqual(['她说"好"']);
  });

  it('CRLF 与 LF 得到同一个网格', () => {
    const lf = parseDelimitedText('a,b\n1,2');
    const crlf = parseDelimitedText('a,b\r\n1,2');
    expect(lf.ok && crlf.ok).toBe(true);
    if (!lf.ok || !crlf.ok) return;
    expect(crlf.grid).toEqual(lf.grid);
  });

  it('末尾换行不会多出一个空行', () => {
    const parsed = parseDelimitedText('a\n1\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grid).toEqual([['a'], ['1']]);
  });

  it('引号没闭合时报错，不猜边界', () => {
    const parsed = parseDelimitedText('a,b\n"x,1');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('unclosed-quote');
  });
});

describe('表头校验', () => {
  it('BOM 不会粘在第一个列名上', () => {
    // 粘上了也不会报错，只会让「按列名取值」全部落空，最难查的那一类问题
    const dataset = parse('\uFEFFweek,value\n2025-01-01,3');
    expect(dataset.columns[0].name).toBe('week');
  });

  it('空内容没有表头可读', () => {
    const result = parseCsvArtifact('\n  \n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('empty-source');
  });

  it('列名为空时指出是第几列', () => {
    const result = parseCsvArtifact('a,,c\n1,2,3');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('blank-column-name');
    expect(result.message).toContain('第 2 列');
  });

  it('重名列直接拒绝', () => {
    // 重名列会让「这条结论引用了哪一列」无法判定，而校验全靠列名定位
    const result = parseCsvArtifact('value,value\n1,2');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('duplicate-column-name');
  });

  it('列数超过上限时拒绝', () => {
    const width = TABULAR_DATASET_LIMITS.maxColumns + 1;
    const header = Array.from({ length: width }, (_, index) => `c${index}`).join(',');
    const result = parseCsvArtifact(header);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('too-many-columns');
  });

  it('残行报错并给出文件里的真实行号', () => {
    const result = parseCsvArtifact('a,b,c\n1,2,3\n4,5');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ragged-row');
    expect(result.message).toContain('第 3 行');
  });

  it('整行为空的行跳过，但不影响后面报错的行号', () => {
    // 行号按过滤后的下标算就会偏移，指到一行看起来完全正常的数据上，
    // 用户拿着这个行号去文件里找，只会更迷惑
    const result = parseCsvArtifact('a,b\n1,2\n\n\n3');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('第 5 行');
  });

  it('空行不进数据，也不计入行数', () => {
    const dataset = parse('a,b\n1,2\n\n3,4\n');
    expect(dataset.rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(dataset.totalRows).toBe(2);
  });
});

describe('列类型推断', () => {
  it('整列都是无歧义写法时才认下类型', () => {
    const dataset = parse(
      [
        'day,amount,flag,label',
        '2025-01-01,12.5,yes,alpha',
        '2025-01-02,-3,no,beta',
        '2025-01-03,1e3,true,gamma',
      ].join('\n'),
    );

    expect(dataset.columns.map((column) => [column.name, column.type])).toEqual([
      ['day', 'date'],
      ['amount', 'number'],
      ['flag', 'boolean'],
      ['label', 'text'],
    ]);
    expect(dataset.rows[2]).toEqual(['2025-01-03', 1000, true, 'gamma']);
  });

  it('带单位或千分位的写法留成文本', () => {
    // 把 12% 读成 12、把 $1,200 读成 1200，会安静地改掉分析结论的量级
    const dataset = parse('rate,revenue\n12%,"$1,200"\n8%,"$980"');
    expect(dataset.columns.map((column) => column.type)).toEqual(['text', 'text']);
    expect(dataset.rows[0]).toEqual(['12%', '$1,200']);
  });

  it('0/1 不算布尔', () => {
    // 0/1 既可能是开关也可能是计数，猜错方向两种分析都不成立
    const dataset = parse('active\n1\n0\n1');
    expect(dataset.columns[0].type).toBe('number');
  });

  it('日历上不存在的日期不算日期', () => {
    const dataset = parse('day\n2025-02-30');
    expect(dataset.columns[0].type).toBe('text');
  });

  it('混入一个异常值就整列退回文本', () => {
    const dataset = parse('amount\n1\n2\nn/a');
    expect(dataset.columns[0].type).toBe('text');
  });

  it('整列为空时是文本而不是数字', () => {
    const dataset = parse('note,value\n,1\n,2');
    expect(findColumn(dataset, 'note')?.column).toMatchObject({
      type: 'text',
      missingCount: 2,
    });
  });

  it('空单元格是 null，不是 0 也不是空串', () => {
    // 读成 0 会让均值、求和、环比全部失真，而且看不出来是缺失
    const dataset = parse('day,amount\n2025-01-01,1\n2025-01-02,\n2025-01-03,3');
    expect(dataset.rows.map((row) => row[1])).toEqual([1, null, 3]);
    expect(dataset.columns[1].missingCount).toBe(1);
  });
});

describe('体量上限', () => {
  it('超出行数上限时截断，并如实记下真实行数', () => {
    const overflow = TABULAR_DATASET_LIMITS.maxRows + 25;
    const csv = ['value', ...Array.from({ length: overflow }, (_, index) => String(index))].join(
      '\n',
    );
    const dataset = parse(csv);

    expect(dataset.rows).toHaveLength(TABULAR_DATASET_LIMITS.maxRows);
    // 截断本身必须留在数据里：Prompt 不能以为自己看到了全表
    expect(dataset.totalRows).toBe(overflow);
    expect(dataset.truncated).toBe(true);
  });

  it('过长单元格被截短并计数，不整份拒绝', () => {
    const long = 'x'.repeat(TABULAR_DATASET_LIMITS.maxCellChars + 40);
    const dataset = parse(`feedback\n${long}\nshort`);

    expect(dataset.rows[0][0]).toHaveLength(TABULAR_DATASET_LIMITS.maxCellChars);
    expect(dataset.truncatedCells).toBe(1);
    // 用户反馈原文这类长文本是合法数据，不该让整个文件读不进来
    expect(dataset.truncated).toBe(false);
  });

  it('行数正好等于上限时不算截断', () => {
    const csv = [
      'value',
      ...Array.from({ length: TABULAR_DATASET_LIMITS.maxRows }, (_, index) => String(index)),
    ].join('\n');
    expect(parse(csv).truncated).toBe(false);
  });
});

describe('两种来源共用同一套构建', () => {
  it('同样的网格从 xlsx 进来，除 sourceFormat 外逐字一致', () => {
    const grid = [
      ['day', 'amount'],
      ['2025-01-01', '10'],
    ];
    const csv = buildTabularDataset({ sourceFormat: 'csv', grid });
    const xlsx = buildTabularDataset({ sourceFormat: 'xlsx', grid });
    expect(csv.ok && xlsx.ok).toBe(true);
    if (!csv.ok || !xlsx.ok) return;

    expect({ ...xlsx.dataset, sourceFormat: 'csv' }).toEqual(csv.dataset);
    expect(xlsx.dataset.schemaVersion).toBe(TABULAR_DATASET_SCHEMA_VERSION);
  });
});

describe('取值', () => {
  it('只有数值列能拿到数值，文本列返回空', () => {
    const dataset = parse('amount,label\n1,a\n2,b');
    expect(numericValues(dataset, 'amount')).toEqual([1, 2]);
    // 拿不到值是有意的：否则文本列会被当成指标算出一个假的均值
    expect(numericValues(dataset, 'label')).toEqual([]);
    expect(numericValues(dataset, 'missing')).toEqual([]);
  });

  it('数值列里的空值不参与计算', () => {
    const dataset = parse('amount\n1\n\n3');
    expect(numericValues(dataset, 'amount')).toEqual([1, 3]);
  });
});
