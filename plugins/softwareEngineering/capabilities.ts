import type { CapabilityDeclaration } from '@core/plugins/types';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from './ids';

/**
 * 插入点 E：工程岗位内嵌的源码能力。
 *
 * 声明归本包所有（随包分发与校验）；工具实现由宿主按 toolName 绑定——
 * 声明缺少对应实现的工具在能力激活时被跳过并记录。
 *
 * `llmRoles` 同理归本包所有：源码检索与理解走 agent 循环，对工具协议遵循率要求高，
 * 所以它有自己的角色，而不是借用基础 Agent 的通用角色。角色名与用途说明都在这里，
 * 基础包不认识 codeAgent。
 */
export const capabilities: CapabilityDeclaration[] = [
  {
    id: SOURCE_REPOSITORY_CAPABILITY_ID,
    llmRoles: [{ name: 'codeAgent', hint: '源码检索与理解，agent 循环对工具遵循率要求高' }],
    // 本包页面用的通用原语（§11.2）：工作区（读 / 遍历 / glob / grep / 符号）、远端拉取
    // （网络出口；拉取本身还要工作区权限，两项都要）、基础问答。
    //
    // `repository:read` 是岗位味词汇（§11.2 点名要退掉），但它现在仍被**宿主侧**的旧工具
    // 实现用着（`desktop/src/main/repo/tools.ts` 逐次按它过网关）。那一块下线时，这个权限
    // 与工具声明一起从本文件删掉——本包自己的页面已经不走那条路了。
    permissions: ['filesystem:workspace', 'network:fetch', 'llm:complete'],
    tools: [
      {
        name: 'glob',
        description: 'Find repository files by name or glob pattern.',
        permission: 'repository:read',
        inputSchemaVersion: 1,
      },
      {
        name: 'find_symbol',
        description: 'Find symbol definitions in the repository.',
        permission: 'repository:read',
        inputSchemaVersion: 1,
      },
      {
        name: 'list_dir',
        description: 'List entries within a repository directory.',
        permission: 'repository:read',
        inputSchemaVersion: 1,
      },
      {
        name: 'read_file',
        description: 'Read a line range from a repository file.',
        permission: 'repository:read',
        inputSchemaVersion: 1,
      },
      {
        name: 'grep',
        description: 'Search repository file contents.',
        permission: 'repository:read',
        inputSchemaVersion: 1,
      },
    ],
  },
];
