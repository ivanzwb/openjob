import { useState } from 'react';
import type { SearchConfig, SearchRoutingRule } from '@core/config';
import { DEFAULT_CONFIG } from '@core/config';
import type { SearchProviderName } from '@core/enums';
import type { EffectiveSearchPolicy } from '@core/search/policy';

/**
 * 域名可信度分级是内容质量控制的主要手段：面经里洗稿、旧内容、
 * 标题党占比很高，不分级的话搜回来的可能比模型编的还差。
 * 所以这张表必须能在界面上改，而不是只躺在 config.json 里。
 *
 * 显示的必须是**生效值**（core 默认 < 岗位包 sourcePolicy < 用户显式修改），
 * 而不是 config.json 里那张表：岗位专属的来源权重在岗位包里，只看 config 的话
 * 换了、卸了岗位包这里都一动不动，看着像没生效。
 */

const CREDIBILITY_HINT: Record<number, string> = {
  0: '黑名单，直接丢弃',
  1: '内容农场',
  2: '一般博客',
  3: '技术社区',
  4: '高质量来源',
  5: '官方 / 一手',
};

const TTL_LABEL: Record<keyof SearchConfig['cacheTtlDays'], string> = {
  companyIntel: '公司情报',
  interviewReports: '面经',
  techDocs: '技术文档',
};

function ruleSummary(rule: SearchRoutingRule): string {
  const parts: string[] = [];
  if (rule.match.lang) parts.push(rule.match.lang === 'zh' ? '中文查询' : '英文查询');
  if (rule.match.domainHint?.length) parts.push(`域名 ${rule.match.domainHint.join(' / ')}`);
  return parts.length > 0 ? parts.join('，') : '任意查询';
}

export function SearchQualityPanel({
  value,
  policy,
  onChange,
}: {
  value: SearchConfig;
  /** 生效策略（含岗位包那段）；取不到时退回用户自己的配置 */
  policy?: EffectiveSearchPolicy | null;
  onChange: (patch: Partial<SearchConfig>) => void;
}): React.JSX.Element {
  const [newDomain, setNewDomain] = useState('');
  const [newScore, setNewScore] = useState(3);

  const effective = policy ?? null;
  const pack = effective?.source ?? null;
  const effectiveCredibility = effective?.domainCredibility ?? value.domainCredibility;
  const effectiveTtl = effective?.cacheTtlDays ?? value.cacheTtlDays;
  const effectiveStaleDays = effective?.techDocStaleDays ?? value.techDocStaleDays;

  /**
   * 岗位包提供、而用户自己那份配置里没有的域名。
   *
   * 这些行不给删：删掉的是用户配置里根本没有的键，删完它还是从包来。要让它消失只能
   * 卸包或换包——所以这里只标出来，让「这一条是谁给的」一目了然。
   */
  const fromPack = new Set(
    pack ? Object.keys(effectiveCredibility).filter((d) => !(d in value.domainCredibility)) : [],
  );

  const domains = Object.entries(effectiveCredibility).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  const setDomain = (domain: string, score: number): void => {
    onChange({ domainCredibility: { ...value.domainCredibility, [domain]: score } });
  };

  const removeDomain = (domain: string): void => {
    const next = { ...value.domainCredibility };
    delete next[domain];
    onChange({ domainCredibility: next });
  };

  const addDomain = (): void => {
    const domain = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) return;
    setDomain(domain, newScore);
    setNewDomain('');
  };

  const setRuleProvider = (index: number, provider: SearchProviderName): void => {
    onChange({ routing: value.routing.map((r, i) => (i === index ? { ...r, provider } : r)) });
  };

  const moveRule = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= value.routing.length) return;
    const next = [...value.routing];
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    onChange({ routing: next });
  };

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[var(--color-muted)]">检索质量与路由</h3>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          可信度 0 的域名直接丢弃，不进上下文。路由规则按顺序匹配，命中即用。
        </p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {pack
            ? `下面是生效值：标着「岗位包」的那些来自 ${pack.id} v${pack.version}，你改过的地方以你的为准。`
            : '下面是生效值：本机没装岗位包，按这里的通用默认值执行；装上岗位包后它会补上自己的来源权重与时效口径。'}
        </p>
      </div>

      <div className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="space-y-2">
          <p className="text-xs text-[var(--color-muted)]">域名可信度</p>
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {domains.map(([domain, score]) => (
              <div key={domain} className="flex items-center gap-2 text-xs">
                <span className={`flex-1 truncate ${score === 0 ? 'text-red-400 line-through' : ''}`}>
                  {domain}
                </span>
                {fromPack.has(domain) && (
                  <span className="shrink-0 text-[10px] text-[var(--color-accent)]">岗位包</span>
                )}
                <select
                  value={score}
                  onChange={(e) => setDomain(domain, Number(e.target.value))}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 outline-none"
                >
                  {[0, 1, 2, 3, 4, 5].map((s) => (
                    <option key={s} value={s}>
                      {s} · {CREDIBILITY_HINT[s]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeDomain(domain)}
                  disabled={fromPack.has(domain)}
                  className="px-1 text-[var(--color-muted)] hover:text-red-400 disabled:opacity-25 disabled:hover:text-[var(--color-muted)]"
                  title={fromPack.has(domain) ? '由岗位包提供，换包或卸包才会消失' : '移除'}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 border-t border-[var(--color-border)] pt-2 text-xs">
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addDomain();
              }}
              placeholder="要拉黑或加权的域名，如 example.com"
              className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 outline-none focus:border-[var(--color-accent)]"
            />
            <select
              value={newScore}
              onChange={(e) => setNewScore(Number(e.target.value))}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 outline-none"
            >
              {[0, 1, 2, 3, 4, 5].map((s) => (
                <option key={s} value={s}>
                  {s} · {CREDIBILITY_HINT[s]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addDomain}
              className="rounded border border-[var(--color-border)] px-2.5 py-1"
            >
              添加
            </button>
          </div>
        </div>

        <div className="space-y-2 border-t border-[var(--color-border)] pt-4">
          <p className="text-xs text-[var(--color-muted)]">缓存有效期（天）</p>
          <div className="grid grid-cols-3 gap-3">
            {(Object.keys(TTL_LABEL) as Array<keyof SearchConfig['cacheTtlDays']>).map((key) => (
              <label key={key} className="space-y-1">
                <span className="block text-[11px]">
                  {TTL_LABEL[key]}
                  {effectiveTtl[key] !== value.cacheTtlDays[key] && (
                    <span className="ml-1 text-[10px] text-[var(--color-accent)]">岗位包</span>
                  )}
                </span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={effectiveTtl[key]}
                  onChange={(e) =>
                    onChange({
                      cacheTtlDays: { ...value.cacheTtlDays, [key]: Number(e.target.value) },
                    })
                  }
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-4">
          <label className="space-y-1">
            <span className="block text-xs text-[var(--color-muted)]">
              技术文档过时阈值（天）
              {effectiveStaleDays !== value.techDocStaleDays && (
                <span className="ml-1 text-[10px] text-[var(--color-accent)]">岗位包</span>
              )}
            </span>
            <input
              type="number"
              min={0}
              max={3650}
              value={effectiveStaleDays}
              onChange={(e) => onChange({ techDocStaleDays: Number(e.target.value) })}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
            />
            <span className="block text-[11px] text-[var(--color-muted)]">
              超过则排到后面并提示模型核对版本，0 为关闭
            </span>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-[var(--color-muted)]">Tavily 地域偏好</span>
            <input
              value={value.providers.tavily.country}
              onChange={(e) =>
                onChange({
                  providers: {
                    ...value.providers,
                    tavily: { ...value.providers.tavily, country: e.target.value },
                  },
                })
              }
              placeholder="留空不限，如 china / united states"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
            />
            <span className="block text-[11px] text-[var(--color-muted)]">
              面经、薪资这类内容强地域相关，填了会优先返回该地区结果
            </span>
          </label>
        </div>

        <div className="space-y-2 border-t border-[var(--color-border)] pt-4">
          <p className="text-xs text-[var(--color-muted)]">路由规则（自上而下匹配）</p>
          {value.routing.map((rule, i) => (
            <div key={`${rule.provider}-${i}`} className="flex items-center gap-2 text-xs">
              <span className="w-4 text-[var(--color-muted)]">{i + 1}</span>
              <span className="flex-1 truncate">{ruleSummary(rule)}</span>
              <select
                value={rule.provider}
                onChange={(e) => setRuleProvider(i, e.target.value as SearchProviderName)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 outline-none"
              >
                <option value="bocha">博查</option>
                <option value="tavily">Tavily</option>
              </select>
              <button
                type="button"
                onClick={() => moveRule(i, -1)}
                disabled={i === 0}
                className="px-1 text-[var(--color-muted)] disabled:opacity-25"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveRule(i, 1)}
                disabled={i === value.routing.length - 1}
                className="px-1 text-[var(--color-muted)] disabled:opacity-25"
              >
                ↓
              </button>
            </div>
          ))}

          <div className="flex items-center gap-2 pt-1 text-xs">
            <span className="text-[var(--color-muted)]">都未命中时</span>
            <select
              value={value.defaultProvider}
              onChange={(e) => onChange({ defaultProvider: e.target.value as SearchProviderName })}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 outline-none"
            >
              <option value="bocha">博查</option>
              <option value="tavily">Tavily</option>
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={() =>
            onChange({
              domainCredibility: { ...DEFAULT_CONFIG.search.domainCredibility },
              cacheTtlDays: { ...DEFAULT_CONFIG.search.cacheTtlDays },
              techDocStaleDays: DEFAULT_CONFIG.search.techDocStaleDays,
              routing: DEFAULT_CONFIG.search.routing.map((r) => ({ ...r })),
              defaultProvider: DEFAULT_CONFIG.search.defaultProvider,
            })
          }
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:text-[var(--color-fg)]"
        >
          恢复默认
        </button>
      </div>
    </section>
  );
}
