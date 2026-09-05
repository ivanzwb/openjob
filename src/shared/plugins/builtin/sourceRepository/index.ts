import type {
  CapabilityPlugin,
  ScopedToolDefinition,
} from '../../types';

export const SOURCE_REPOSITORY_CAPABILITY_ID = 'source-repository';
export const SOURCE_REPOSITORY_CAPABILITY_VERSION = '1.0.0';

export const SOURCE_REPOSITORY_TOOL_DEFINITIONS = [
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
] as const satisfies readonly ScopedToolDefinition[];

/**
 * Built-in declaration only. The plugin contributes contracts to the host registry;
 * executable implementations remain host-owned and are always permission-gated.
 */
export const sourceRepositoryCapabilityPlugin: CapabilityPlugin = {
  manifest: {
    id: SOURCE_REPOSITORY_CAPABILITY_ID,
    version: SOURCE_REPOSITORY_CAPABILITY_VERSION,
    type: 'capability',
    displayName: 'Source Repository',
    description: 'Read-only repository navigation, source inspection, and grounded citations.',
    compatibility: {
      core: '^1.0.0',
      schema: 22,
    },
    permissions: ['repository:read'],
    runtime: {
      desktop: 'full',
      mobile: 'view-only',
    },
  },
  register(registry) {
    for (const tool of SOURCE_REPOSITORY_TOOL_DEFINITIONS) {
      registry.registerTool(tool);
    }
  },
};
