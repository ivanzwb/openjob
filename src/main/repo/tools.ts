import type OpenAI from 'openai';
import type { Citation } from '@shared/entities';
import { formatPathSuggestions, suggestRepoPaths } from '@shared/repo/pathSuggest';
import { normalizeRepoPath } from '@shared/repo/virtualFs';
import { agentTools, runTool, type ToolContext, type ToolOutcome } from '../llm/tools';
import { findSymbolRepo, globRepo, grepRepo, listDir, readFileRange } from './files';
import { recordCodeRefs } from './repository';
import { listRepoFilePaths } from './snapshot';

export const CODE_REPO_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        '按文件名或 glob 找文件，如 "agent.ts"、"src/**/*.ts"。只给文件名时在所有目录下找。' +
        '不确定某个文件在哪就先用它，不要凭猜测写路径',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '文件名或 glob 模式' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description:
        '按名字找函数/类/接口/类型的定义处，返回 path:line。' +
        '想知道某个函数写在哪就用它——grep 找到的多是调用点，不是定义',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '符号名，支持前缀和子串' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
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
    type: 'function',
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
    type: 'function',
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

export function mergedCodeAgentTools(
  ctx?: ToolContext,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [...CODE_REPO_TOOLS, ...agentTools(ctx)];
}

export async function runCodeRepoTool(
  name: string,
  args: Record<string, unknown>,
  repoRoot: string,
  signal?: AbortSignal,
  ctx?: ToolContext & { repoId?: string },
): Promise<ToolOutcome> {
  if (name === 'glob') {
    const pattern = String(args['pattern'] ?? '');
    return {
      content: globRepo(repoRoot, pattern),
      summary: `glob ${pattern}`,
      citations: [],
    };
  }

  if (name === 'find_symbol') {
    const symbol = String(args['name'] ?? '');
    return {
      content: findSymbolRepo(repoRoot, symbol),
      summary: `find_symbol ${symbol}`,
      citations: [],
    };
  }

  if (name === 'list_dir') {
    const path = String(args['path'] ?? '.');
    const content = listDir(repoRoot, path);
    return {
      content,
      summary: `list_dir ${path}`,
      citations: [],
    };
  }

  if (name === 'read_file') {
    const path = String(args['path'] ?? '');
    const start = typeof args['start_line'] === 'number' ? args['start_line'] : 1;
    const end = typeof args['end_line'] === 'number' ? args['end_line'] : undefined;

    let range;
    try {
      range = readFileRange(repoRoot, path, start, end);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // 抛出去只会被 agent 循环包成「工具执行失败」，把本机绝对路径塞进上下文，
      // 而模型仍然不知道真实路径长什么样，往往接着编下一个。回一条照着就能改的结果。
      const suggestions = ctx?.repoId ? suggestRepoPaths(listRepoFilePaths(ctx.repoId), path) : [];
      return {
        content:
          `文件不存在：${normalizeRepoPath(path)}${formatPathSuggestions(suggestions)}\n` +
          `用 glob 按文件名找到真实路径再读，不要凭猜测引用。`,
        summary: `read ${path} 未找到`,
        citations: [],
      };
    }
    const { content, startLine, endLine } = range;

    if (ctx?.repoId) {
      recordCodeRefs(ctx.repoId, [{ filePath: path, startLine, endLine, snippet: content }]);
    }

    return {
      content,
      summary: `read ${path}:${startLine}-${endLine}`,
      citations: [
        {
          kind: 'code',
          filePath: path,
          startLine,
          endLine,
        },
      ],
    };
  }

  if (name === 'grep') {
    const pattern = String(args['pattern'] ?? '');
    const path = String(args['path'] ?? '.');
    const content = grepRepo(repoRoot, pattern, path);
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

    if (ctx?.repoId && citations.length > 0) {
      recordCodeRefs(
        ctx.repoId,
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

  return runTool(name, args, signal, ctx);
}
