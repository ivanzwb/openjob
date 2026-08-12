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

export function parseJsonResponse<T>(raw: string): T {
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

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`JSON 解析失败：${detail}`);
}
