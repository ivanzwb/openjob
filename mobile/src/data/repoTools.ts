import type { SQLiteDatabase } from 'expo-sqlite';
import type { Citation } from '@shared/entities';
import {
  grepFileContents,
  listDirFromPaths,
  normalizeRepoPath,
  readFileRangeFromContent,
} from '@shared/repo/virtualFs';
import { getRepoFileContent, loadRepoFiles, recordCodeRefs } from './repoFiles';

export interface ToolOutcome {
  content: string;
  summary: string;
  citations: Citation[];
}

export function runCodeRepoTool(
  name: string,
  args: Record<string, unknown>,
  db: SQLiteDatabase,
  repoId: string,
): ToolOutcome {
  if (name === 'list_dir') {
    const path = String(args['path'] ?? '.');
    const paths = loadRepoFiles(db, repoId).map((f) => f.path);
    const content = listDirFromPaths(paths, path);
    return { content, summary: `list_dir ${path}`, citations: [] };
  }

  if (name === 'read_file') {
    const path = normalizeRepoPath(String(args['path'] ?? ''));
    const start = typeof args['start_line'] === 'number' ? args['start_line'] : 1;
    const end = typeof args['end_line'] === 'number' ? args['end_line'] : undefined;
    const raw = getRepoFileContent(db, repoId, path);
    if (!raw) {
      return {
        content: `文件不存在或未同步: ${path}`,
        summary: `read ${path} 失败`,
        citations: [],
      };
    }
    const { content, startLine, endLine } = readFileRangeFromContent(raw, start, end);
    recordCodeRefs(db, repoId, [{ filePath: path, startLine, endLine, snippet: content }]);
    return {
      content,
      summary: `read ${path}:${startLine}-${endLine}`,
      citations: [{ kind: 'code', filePath: path, startLine, endLine }],
    };
  }

  if (name === 'grep') {
    const pattern = String(args['pattern'] ?? '');
    const path = String(args['path'] ?? '.');
    const files = loadRepoFiles(db, repoId);
    const content = grepFileContents(files, pattern, path);
    const citations: Citation[] = [];
    for (const line of content.split('\n')) {
      const m = /^([^:]+):(\d+):/.exec(line);
      if (m) {
        citations.push({
          kind: 'code',
          filePath: m[1]!,
          startLine: Number(m[2]),
          endLine: Number(m[2]),
        });
      }
    }
    if (citations.length > 0) {
      recordCodeRefs(
        db,
        repoId,
        citations.slice(0, 20).map((c) => ({
          filePath: c.filePath!,
          startLine: c.startLine!,
          endLine: c.endLine!,
          snippet: null,
        })),
      );
    }
    return { content, summary: `grep "${pattern}"`, citations };
  }

  throw new Error(`未知仓库工具: ${name}`);
}

export const CODE_REPO_TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: '列出仓库内目录内容。path 为相对仓库根的路径，默认 "."',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: '读取文件内容（带行号）。必须用于核实代码细节，结论需引用 file:line',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对仓库根的文件路径' },
          start_line: { type: 'number' },
          end_line: { type: 'number' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'grep',
      description: '在仓库内搜索文本/正则。返回 file:line 格式结果',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: '搜索范围，默认整个仓库' },
        },
        required: ['pattern'],
      },
    },
  },
];
