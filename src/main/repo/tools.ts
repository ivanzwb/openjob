import type OpenAI from 'openai';
import type { Citation } from '@shared/entities';
import { AGENT_TOOLS, runTool, type ToolOutcome } from '../llm/tools';
import { grepRepo, listDir, readFileRange } from './files';

export const CODE_REPO_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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
  ...AGENT_TOOLS,
];

export function mergedCodeAgentTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return CODE_REPO_TOOLS;
}

export async function runCodeRepoTool(
  name: string,
  args: Record<string, unknown>,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
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
    const { content, startLine, endLine } = readFileRange(repoRoot, path, start, end);
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
    return { content, summary: `grep "${pattern}"`, citations };
  }

  return runTool(name, args, signal);
}
