/**
 * 代码插件的 **artifact 原语** 宿主实现（分发计划 §11.2）。
 *
 * 语义：**用户显式提供的文件读入（表格 / 文档）**。与工作区原语的关键区别是
 * 「谁来决定读哪个文件」——工作区的路径由包给、越界就拒；artifact **不接收路径**，
 * 包只能发起一次「请用户选个文件」的请求，由宿主在主进程弹选择器、读用户选中的那一个。
 * 因此：
 *
 * 1. **没有用户选择就没有内容**：选择器取消即拒，调用方给不了路径（请求类型里没有 path）；
 * 2. **只读**：读进来的文本 / 表格直接返回给包，不落进本包工作区，除非包自己再写；
 * 3. **上限即报错**：文件大小、行数、单元格总数、单格字符数都有上限，超限抛错而不是静默截断。
 *
 * 这一层不 import `plugins/package/(contract|replay)`，也不含任何代码执行入口。
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { dialog } from 'electron';
import type { PluginArtifact } from '@core/plugins/pluginRuntime/host';
import type { PluginPermissionGateway } from './permissionGateway';

/** 原语上限。超限一律抛错，绝不静默截断——静默截断会让包侧拿到「看起来完整」的错结果。 */
export const ARTIFACT_LIMITS = {
  /** 单个用户文件的字节上限 */
  readBytes: 4 * 1024 * 1024,
  /** 行数（记录数）上限 */
  maxRows: 2000,
  /** 单元格总数上限（行 × 列） */
  maxCells: 100_000,
  /** 单格字符上限；只对分隔文件生效，纯文本文档的行不受这一条约束 */
  maxCellChars: 4096,
} as const;

/** 按扩展名粗判分隔格式与分隔符；判不出来当纯文本。 */
const DELIMITED_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.csv': ',',
  '.tsv': '\t',
};

export type ArtifactErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'binary'
  | 'read-limit'
  | 'row-limit'
  | 'cell-limit'
  | 'cell-length-limit';

export class ArtifactError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactError';
  }
}

/** 权限未声明 / 被拒时的错误；不带出任何调用方给的路径。 */
export class ArtifactAccessDeniedError extends Error {
  constructor(readonly reason: string) {
    super(`插件 artifact 访问被拒绝（${reason}）。`);
    this.name = 'ArtifactAccessDeniedError';
  }
}

/** 用户没有选择文件（选择器取消）：原语的「显式动作」不成立，读不出任何东西。 */
export class ArtifactSelectionCanceledError extends Error {
  constructor() {
    super('用户没有选择文件，artifact 原语读不到内容。');
    this.name = 'ArtifactSelectionCanceledError';
  }
}

/** 生产用选择器：弹在主进程，渲染层不传路径，也就没有「指定任意文件让主进程去读」这条路。 */
async function defaultSelect(): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择一个文件交给插件',
    properties: ['openFile'],
    filters: [
      { name: '表格 / 文档', extensions: ['csv', 'tsv', 'txt', 'md', 'json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (canceled || filePaths.length === 0) return null;
  return filePaths[0]!;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 读取用户选中的那个文件并套上上限；`selected` 一定来自选择器，不含调用方给的路径。 */
export function readSelectedArtifact(selected: string): PluginArtifact {
  if (typeof selected !== 'string' || selected.length === 0) {
    throw new ArtifactError('invalid-input', '选择器没有给出文件');
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(selected);
  } catch {
    throw new ArtifactError('not-found', '选中的文件读不到');
  }
  if (!stats.isFile()) throw new ArtifactError('not-found', '选中的不是文件');
  if (stats.size > ARTIFACT_LIMITS.readBytes) {
    throw new ArtifactError(
      'read-limit',
      `文件超过 ${ARTIFACT_LIMITS.readBytes} 字节上限`,
    );
  }

  const buffer = readFileSync(selected);
  if (buffer.length > ARTIFACT_LIMITS.readBytes) {
    throw new ArtifactError(
      'read-limit',
      `文件超过 ${ARTIFACT_LIMITS.readBytes} 字节上限`,
    );
  }
  // 二进制（xlsx 等）交给解析器，原语不假装能读懂；这里如实拒。
  if (buffer.includes(0)) {
    throw new ArtifactError('binary', '不支持二进制文件；表格请用 CSV / TSV，解析由包自己负责');
  }

  const name = basename(selected);
  const text = buffer.toString('utf8');
  const delimiter = DELIMITED_BY_EXTENSION[extname(name).toLowerCase()];
  const lines = splitLines(text);
  if (lines.length > ARTIFACT_LIMITS.maxRows) {
    throw new ArtifactError('row-limit', `行数超过 ${ARTIFACT_LIMITS.maxRows} 上限`);
  }

  let cells = 0;
  const rows = lines.map((line) => {
    const row = delimiter ? line.split(delimiter) : [line];
    if (delimiter) {
      for (const cell of row) {
        if (cell.length > ARTIFACT_LIMITS.maxCellChars) {
          throw new ArtifactError(
            'cell-length-limit',
            `单元格字符数超过 ${ARTIFACT_LIMITS.maxCellChars} 上限`,
          );
        }
      }
    }
    cells += row.length;
    if (cells > ARTIFACT_LIMITS.maxCells) {
      throw new ArtifactError('cell-limit', `单元格总数超过 ${ARTIFACT_LIMITS.maxCells} 上限`);
    }
    return row;
  });

  return {
    name,
    format: delimiter ? 'delimited' : 'text',
    text,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    rows,
  };
}

/** 服务层入参：网关每次调用都过一道；`select` 是测试用的夹具覆盖。 */
export interface PluginArtifactAccess {
  permissionGateway: PluginPermissionGateway;
  /** Test seam；生产为 `dialog.showOpenDialog`（弹在主进程）。返回用户选中的绝对路径或 null。 */
  select?: (pluginId: string) => Promise<string | null> | string | null;
}

/**
 * 读入用户显式选择的一个文件。**请求里没有路径**：唯一的来源是选择器，
 * 选择器没给出文件就拒——这是 artifact 与工作区原语的本质区别。
 */
export async function artifactRead(
  pluginId: string,
  access: PluginArtifactAccess,
): Promise<PluginArtifact> {
  const decision = access.permissionGateway.authorizePlugin({
    pluginId,
    permission: 'artifact:read',
  });
  if (!decision.allowed) throw new ArtifactAccessDeniedError(decision.code);

  const selected = await (access.select ?? defaultSelect)(pluginId);
  if (!selected) throw new ArtifactSelectionCanceledError();

  return readSelectedArtifact(selected);
}
