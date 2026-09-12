import { describe, expect, it } from 'vitest';
import { nextVisibleTab } from './capabilityNav';

describe('nextVisibleTab', () => {
  it('当前页签仍可见时保持不动', () => {
    expect(nextVisibleTab('repos', (tab) => tab !== 'campaigns', 'campaigns')).toBe('repos');
  });

  it('当前页签被隐藏时回退到落点页签', () => {
    expect(nextVisibleTab('repos', (tab) => tab !== 'repos', 'campaigns')).toBe('campaigns');
  });
});
