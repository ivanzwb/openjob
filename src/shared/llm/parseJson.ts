/**
 * 允许把半截输出补全成可用结果的 prompt。
 *
 * 抢救的代价是「少掉的部分用户看不出来」，所以只给「单个对象 + 长文本字段」的
 * 响应开：评分被截断时丢的是改进稿的尾巴，score 和 feedbackMd 还在，稿子断在
 * 哪儿一眼能看见。返回数组的响应（JD 诊断的考点清单之类）绝不能开——那是静默
 * 少给几个考点，用户以为诊断完整跑完了。
 */
export const SALVAGE_TRUNCATED_PROMPTS = new Set(['quiz.score', 'design.score']);

export interface ParseJsonOptions {
  /** 见 SALVAGE_TRUNCATED_PROMPTS，默认关闭 */
  salvageTruncated?: boolean;
}

interface JsonScan {
  /** 扫到结尾时还在字符串里，说明字符串没收口 */
  inString: boolean;
  /** 最后一个字符是转义符本身，补全前得先去掉 */
  danglingEscape: boolean;
  /** 还没闭合的容器，按出现先后 */
  open: ('}' | ']')[];
  /** 不在字符串里的逗号位置，用来退回到上一个完整成员 */
  commas: number[];
}

function scanJson(json: string): JsonScan {
  let inString = false;
  let escaped = false;
  const open: ('}' | ']')[] = [];
  const commas: number[] = [];

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') open.push('}');
    else if (ch === '[') open.push(']');
    else if (ch === '}' || ch === ']') open.pop();
    else if (ch === ',' && open.length > 0) commas.push(i);
  }

  return { inString, danglingEscape: escaped, open, commas };
}

/** 有没闭合的容器 = 这段输出是被截断的，而不是格式脏 */
export function looksTruncated(raw: string): boolean {
  return scanJson(extractJsonSlice(stripMarkdownFences(raw.trim()))).open.length > 0;
}

/** 结尾停在 `"key":` 上时，把这个只写了一半的成员整个去掉 */
function dropDanglingKey(text: string): string {
  const dangling = /,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/.exec(text);
  return dangling ? text.slice(0, dangling.index) : text;
}

/** 把 json 截到 end 处再补全收口；没有未闭合容器就说明不是截断，返回 null */
function closeTruncated(json: string, end: number): string | null {
  const scan = scanJson(json.slice(0, end));
  if (scan.open.length === 0) return null;

  let text = json.slice(0, end);
  if (scan.danglingEscape) text = text.slice(0, -1);
  if (scan.inString) text += '"';
  else text = dropDanglingKey(text.replace(/[\s,]+$/, ''));

  return text + [...scan.open].reverse().join('');
}

/**
 * 截断可能停在任何位置：字符串中间、键名中间、半个数字。补全收口能救回前两种，
 * 剩下的靠逐个退回到上一个逗号，把那个残缺成员整个丢掉再试。
 */
function truncationCandidates(json: string): string[] {
  const out: string[] = [];
  const closed = closeTruncated(json, json.length);
  if (closed) out.push(closed);

  const { commas } = scanJson(json);
  for (let i = commas.length - 1; i >= 0 && out.length < 5; i--) {
    const candidate = closeTruncated(json, commas[i]!);
    if (candidate) out.push(candidate);
  }

  return out;
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^\uFEFF?```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function extractJsonSlice(text: string): string {
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    return text.slice(objStart, objEnd + 1);
  }

  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    return text.slice(arrStart, arrEnd + 1);
  }

  return text;
}

function repairJsonText(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      if (inString) escaped = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        inString = true;
        result += ch;
        continue;
      }

      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      const next = json[j];
      if (next === undefined || next === ':' || next === ',' || next === '}' || next === ']') {
        inString = false;
        result += ch;
      } else {
        result += '\\"';
      }
      continue;
    }

    if (inString) {
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
    }

    result += ch;
  }

  return result.replace(/,\s*([}\]])/g, '$1');
}

export function parseJsonResponse<T>(raw: string, options: ParseJsonOptions = {}): T {
  const candidates = new Set<string>();
  const trimmed = raw.trim();
  const stripped = stripMarkdownFences(trimmed);
  const extracted = extractJsonSlice(stripped);

  for (const candidate of [trimmed, stripped, extracted]) {
    if (candidate) candidates.add(candidate);
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    for (const attempt of [candidate, repairJsonText(candidate)]) {
      try {
        return JSON.parse(attempt) as T;
      } catch (err) {
        lastError = err;
      }
    }
  }

  // 补全收口是最后一招：正常解析全败了才试，免得把本来能好好解析的输出改坏
  if (options.salvageTruncated) {
    for (const candidate of candidates) {
      for (const attempt of [candidate, repairJsonText(candidate)]) {
        for (const salvaged of truncationCandidates(attempt)) {
          try {
            return JSON.parse(salvaged) as T;
          } catch (err) {
            lastError = err;
          }
        }
      }
    }
  }

  // 「Unexpected end of input」说不清是被截断还是格式脏，这里替它说清楚
  if (scanJson(extracted).open.length > 0) {
    throw new Error('JSON 解析失败：模型输出被截断，没有完整的 JSON');
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`JSON 解析失败：${detail}`);
}
