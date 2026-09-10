import { describe, expect, it, vi } from 'vitest';

vi.mock('../search', () => ({
  fetchUrl: vi.fn(),
  freshnessLabel: vi.fn(),
  search: vi.fn(),
}));
vi.mock('./compress', () => ({
  compressForContext: vi.fn(),
}));

import { AGENT_TOOLS, mergeToolDefinitions } from './tools';

describe('tool definition contracts', () => {
  it('rejects duplicate tool names instead of overriding a registration', () => {
    const duplicate = AGENT_TOOLS[0]!;

    expect(() => mergeToolDefinitions([duplicate], [duplicate])).toThrow(
      `工具重复注册：${duplicate.function.name}`,
    );
  });
});
