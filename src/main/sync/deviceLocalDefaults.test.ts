import { describe, expect, it } from 'vitest';
import { deviceLocalInsertDefaults } from './deviceLocalDefaults';

describe('deviceLocalInsertDefaults', () => {
  it('repo 表补齐 local_path 占位值', () => {
    expect(deviceLocalInsertDefaults('repo', {})).toEqual({ local_path: '' });
  });

  it('非 repo 表不补任何列', () => {
    expect(deviceLocalInsertDefaults('task', {})).toEqual({});
    expect(deviceLocalInsertDefaults('knowledge_node', { id: 'n1' })).toEqual({});
  });

  it('已同步的值不影响占位默认值（占位只由表名决定）', () => {
    expect(deviceLocalInsertDefaults('repo', { url: 'git@x', status: 'pending' })).toEqual({
      local_path: '',
    });
  });
});