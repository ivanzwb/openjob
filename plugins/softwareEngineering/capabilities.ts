import type { CapabilityDeclaration } from '@core/plugins/types';

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
    id: 'source-repository',
    llmRoles: [{ name: 'codeAgent', hint: '源码检索与理解，agent 循环对工具遵循率要求高' }],
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
