import type { Citation } from '@core/entities';
// 源码工具实现绑定：与 SE 包 capabilities.ts 里的声明逐一对应
const SOURCE_REPOSITORY_TOOL_DEFINITIONS = [
  { name: 'glob', description: 'Find repository files by name or glob pattern.', permission: 'repository:read', inputSchemaVersion: 1 },
  { name: 'find_symbol', description: 'Find symbol definitions in the repository.', permission: 'repository:read', inputSchemaVersion: 1 },
  { name: 'list_dir', description: 'List entries within a repository directory.', permission: 'repository:read', inputSchemaVersion: 1 },
  { name: 'read_file', description: 'Read a line range from a repository file.', permission: 'repository:read', inputSchemaVersion: 1 },
  { name: 'grep', description: 'Search repository file contents.', permission: 'repository:read', inputSchemaVersion: 1 },
] as const;
import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';
import { formatPathSuggestions, suggestRepoPaths } from '@core/repo/pathSuggest';
import { normalizeRepoPath } from '@core/repo/virtualFs';
import {
  agentTools,
  mergeToolDefinitions,
  runTool,
  type AgentFunctionTool,
  type ToolContext,
  type ToolOutcome,
} from '../llm/tools';
import {
  PermissionDeniedError,
  permissionGateway as defaultPermissionGateway,
  type PermissionGateway,
} from '../plugins/permissionGateway';
import {
  findSymbolRepoAsync,
  globRepoAsync,
  grepRepoAsync,
  listDirAsync,
  readFileRangeAsync,
} from './files';
import { recordCodeRefs } from './repository';
import { listRepoFilePaths } from './snapshot';

export const CODE_REPO_TOOLS: AgentFunctionTool[] = [
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

const SOURCE_REPOSITORY_TOOL_NAMES: ReadonlySet<string> = new Set(
  SOURCE_REPOSITORY_TOOL_DEFINITIONS.map((tool) => tool.name),
);

export function mergedCodeAgentTools(
  ctx?: ToolContext,
): AgentFunctionTool[] {
  return mergeToolDefinitions(CODE_REPO_TOOLS, agentTools(ctx));
}

export interface CodeRepoToolContext extends ToolContext {
  repoId?: string;
  /** Test seam; production callers always use the process-wide default-deny gateway. */
  permissionGateway?: PermissionGateway;
}

export async function runCodeRepoTool(
  name: string,
  args: Record<string, unknown>,
  repoRoot: string,
  signal?: AbortSignal,
  ctx?: CodeRepoToolContext,
): Promise<ToolOutcome> {
  if (SOURCE_REPOSITORY_TOOL_NAMES.has(name)) {
    const decision = (ctx?.permissionGateway ?? defaultPermissionGateway).authorize({
      campaignId: ctx?.campaignId ?? '',
      capabilityId: CORE_CAPABILITIES_PACK_ID,
      permission: 'repository:read',
      resource: {
        kind: 'repository',
        id: ctx?.repoId ?? '',
      },
    });
    if (!decision.allowed) throw new PermissionDeniedError(decision);
  }

  if (name === 'glob') {
    const pattern = String(args['pattern'] ?? '');
    return {
      content: await globRepoAsync(repoRoot, pattern),
      summary: `glob ${pattern}`,
      citations: [],
    };
  }

  if (name === 'find_symbol') {
    const symbol = String(args['name'] ?? '');
    const content = await findSymbolRepoAsync(repoRoot, symbol);
    const citations: Citation[] = [];
    for (const line of content.split('\n')) {
      const match = /^(.+):(\d+):/.exec(line);
      if (!match) continue;
      citations.push({
        kind: 'code',
        filePath: match[1]!,
        startLine: Number(match[2]),
        endLine: Number(match[2]),
      });
    }
    return {
      content,
      summary: `find_symbol ${symbol}`,
      citations,
    };
  }

  if (name === 'list_dir') {
    const path = String(args['path'] ?? '.');
    const content = await listDirAsync(repoRoot, path);
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
      range = await readFileRangeAsync(repoRoot, path, start, end);
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
    const content = await grepRepoAsync(repoRoot, pattern, path);
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
