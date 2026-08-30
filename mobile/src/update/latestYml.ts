/**
 * 解析 electron-builder generic provider 的 latest.yml。
 *
 * 只取更新检测需要的 version / releaseDate 两个字段。不引 YAML 依赖：
 * 这个文件是 electron-builder 机器生成的，顶层键顶格写、值要么裸要么带引号，
 * 用简单的行解析就够，也更好测。files 列表条目有缩进，不会撞到顶层键。
 */

export interface LatestYml {
  /** 版本号（electron-builder 一般不带 v 前缀，解析后原样返回） */
  version: string | null;
  /** ISO 时间字符串，或 null（某些平台/老版本没有） */
  releaseDate: string | null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseLatestYml(text: string): LatestYml {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    // 缩进的是 files 列表里的条目（url/sha512/size），不是顶层键
    if (!line || line.startsWith(' ') || line.startsWith('\t')) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    fields[match[1]] = unquote(match[2]);
  }
  return {
    version: fields.version || null,
    releaseDate: fields.releaseDate || null,
  };
}