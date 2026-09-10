import { describe, expect, it } from 'vitest';
import {
  PluginContractError,
  assertValidCapabilityPlugin,
} from '../../contracts';
import type { CapabilityPlugin, CapabilityRegistry } from '../../types';
import {
  SOURCE_REPOSITORY_TOOL_DEFINITIONS,
  sourceRepositoryCapabilityPlugin,
} from '.';

describe('sourceRepositoryCapabilityPlugin', () => {
  it('registers the built-in repository tools under repository:read', () => {
    expect(() => assertValidCapabilityPlugin(sourceRepositoryCapabilityPlugin)).not.toThrow();

    const tools: string[] = [];
    const registry: CapabilityRegistry = {
      registerTool(tool) {
        expect(tool.permission).toBe('repository:read');
        tools.push(tool.name);
      },
      registerArtifactParser() {
        throw new Error('unexpected parser');
      },
      registerInteractionType() {
        throw new Error('unexpected interaction');
      },
    };

    sourceRepositoryCapabilityPlugin.register(registry);

    expect(tools).toEqual(SOURCE_REPOSITORY_TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('rejects a duplicate permission contract', () => {
    const invalid: CapabilityPlugin = {
      ...sourceRepositoryCapabilityPlugin,
      manifest: {
        ...sourceRepositoryCapabilityPlugin.manifest,
        permissions: ['repository:read', 'repository:read'],
      },
    };

    expect(() => assertValidCapabilityPlugin(invalid)).toThrow(PluginContractError);
  });
});
