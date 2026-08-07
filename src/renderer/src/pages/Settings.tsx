import { useEffect, useState } from 'react';
import type { AppConfig, PriorityWeights } from '@shared/config';
import { DEFAULT_PRIORITY_WEIGHTS } from '@shared/config';
import { LLM_ROLES, type CoverageType, type LlmRole } from '@shared/enums';
import type { ProviderTestResult } from '@shared/ipc';
import { invoke } from '../ipc';
import { SecretField } from '../components/SecretField';

const ROLE_HINTS: Record<LlmRole, string> = {
  outline: '生成知识图谱大纲，需要结构化能力，用量小',
  explain: '生成三档讲解，调用最频繁，是成本大头',
  codeAgent: '源码检索与理解，必须支持 function calling',
  quiz: '出题与评分，需要稳定的评判尺度',
  embedding: '向量化，用于去重与真题匹配',
};

const COVERAGE_TYPES: CoverageType[] = ['deepDive', 'gap', 'landmine', 'extra'];

const COVERAGE_LABEL: Record<CoverageType, string> = {
  deepDive: '必深挖',
  gap: '短板',
  landmine: '雷区',
  extra: '加分项',
};

function ExpField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="space-y-1">
      <span className="block text-xs">{label}</span>
      <input
        type="number"
        step={0.1}
        min={0}
        max={3}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
      />
      <span className="block text-[10px] text-[var(--color-muted)]">{hint}</span>
    </label>
  );
}

export function Settings(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState<Partial<Record<LlmRole, ProviderTestResult | 'running'>>>({});
  const [dbInfo, setDbInfo] = useState<{ ok: boolean; tables: number; path: string } | null>(null);

  useEffect(() => {
    void invoke('config:get', undefined).then(setConfig);
    void invoke('db:health', undefined).then(setDbInfo);
  }, []);

  if (!config) return <p className="p-6 text-sm text-[var(--color-muted)]">加载配置…</p>;

  const persist = async (next: AppConfig): Promise<void> => {
    setConfig(next);
    const merged = await invoke('config:update', next);
    setConfig(merged);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const updateProvider = (index: number, patch: Partial<AppConfig['llm']['providers'][0]>): void => {
    const providers = config.llm.providers.map((p, i) => (i === index ? { ...p, ...patch } : p));
    void persist({ ...config, llm: { ...config.llm, providers } });
  };

  const updateRole = (role: LlmRole, patch: Partial<AppConfig['llm']['roles'][LlmRole]>): void => {
    void persist({
      ...config,
      llm: { ...config.llm, roles: { ...config.llm.roles, [role]: { ...config.llm.roles[role], ...patch } } },
    });
  };

  const updatePriority = (patch: Partial<PriorityWeights>): void => {
    void persist({ ...config, priority: { ...config.priority, ...patch } });
  };

  const runTest = async (role: LlmRole): Promise<void> => {
    setTests((t) => ({ ...t, [role]: 'running' }));
    const result = await invoke('llm:testRole', { role });
    setTests((t) => ({ ...t, [role]: result }));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">设置</h2>
        {saved && <span className="text-xs text-emerald-400">已保存</span>}
      </header>

      <section className="space-y-4">
        <h3 className="text-sm font-medium text-[var(--color-muted)]">模型 Provider</h3>
        {config.llm.providers.map((p, i) => (
          <div
            key={p.id}
            className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-[var(--color-muted)]">名称</span>
                <input
                  value={p.label}
                  onChange={(e) => updateProvider(i, { label: e.target.value })}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-[var(--color-muted)]">Base URL（OpenAI 兼容）</span>
                <input
                  value={p.baseUrl}
                  onChange={(e) => updateProvider(i, { baseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </label>
            </div>
            <SecretField label="API Key" secretRef={p.apiKeyRef} />
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-[var(--color-muted)]">角色分流</h3>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            按任务用不同模型，而不是全局一个模型。讲解调用量最大，可以配便宜的；
            源码 Agent 必须支持 function calling。
          </p>
        </div>

        {LLM_ROLES.map((role) => {
          const rc = config.llm.roles[role];
          const test = tests[role];
          return (
            <div
              key={role}
              className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <div className="flex items-baseline gap-2">
                <code className="text-sm text-sky-300">{role}</code>
                <span className="text-xs text-[var(--color-muted)]">{ROLE_HINTS[role]}</span>
              </div>
              <div className="flex gap-2">
                <select
                  value={rc.providerId}
                  onChange={(e) => updateRole(role, { providerId: e.target.value })}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none"
                >
                  {config.llm.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  value={rc.model}
                  onChange={(e) => updateRole(role, { model: e.target.value })}
                  placeholder="模型名，如 deepseek-chat"
                  className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  type="button"
                  onClick={() => void runTest(role)}
                  disabled={test === 'running'}
                  className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  {test === 'running' ? '测试中…' : '测试'}
                </button>
              </div>
              {test && test !== 'running' && (
                <p className={`text-xs ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  {test.ok ? `${test.latencyMs}ms · ` : ''}
                  {test.message}
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-[var(--color-muted)]">搜索 Provider</h3>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            中文查询走博查，英文文档走 Tavily，由语言和域名自动路由，无需手动切换。
          </p>
        </div>
        <div className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <SecretField label="博查 API Key（中文内容）" secretRef={config.search.providers.bocha.apiKeyRef} />
          <SecretField label="Tavily API Key（英文内容 / 网页抓取）" secretRef={config.search.providers.tavily.apiKeyRef} />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-[var(--color-muted)]">优先级公式</h3>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            优先级 = 考察概率<sup>p</sup> × 掌握差距<sup>g</sup> × 覆盖类型倍率 ÷ 预估分钟
            <sup>c</sup>。改完后在 Campaign 页重新生成计划生效。
          </p>
        </div>
        <div className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="grid grid-cols-3 gap-3">
            <ExpField
              label="考察概率指数 p"
              hint="调大更偏高频考点"
              value={config.priority.probExp}
              onChange={(v) => updatePriority({ probExp: v })}
            />
            <ExpField
              label="掌握差距指数 g"
              hint="调大更偏完全不会的点"
              value={config.priority.gapExp}
              onChange={(v) => updatePriority({ gapExp: v })}
            />
            <ExpField
              label="时长惩罚指数 c"
              hint="0 表示完全不看时长"
              value={config.priority.costExp}
              onChange={(v) => updatePriority({ costExp: v })}
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs text-[var(--color-muted)]">覆盖类型倍率 / 目标掌握度</p>
            <div className="grid grid-cols-2 gap-3">
              {COVERAGE_TYPES.map((ct) => (
                <div key={ct} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-xs">{COVERAGE_LABEL[ct]}</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    max={5}
                    value={config.priority.coverageBoost[ct]}
                    onChange={(e) =>
                      updatePriority({
                        coverageBoost: {
                          ...config.priority.coverageBoost,
                          [ct]: Number(e.target.value),
                        },
                      })
                    }
                    className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
                    title="倍率"
                  />
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    max={5}
                    value={config.priority.targetMastery[ct]}
                    onChange={(e) =>
                      updatePriority({
                        targetMastery: {
                          ...config.priority.targetMastery,
                          [ct]: Number(e.target.value),
                        },
                      })
                    }
                    className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
                    title="目标掌握度"
                  />
                </div>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void persist({ ...config, priority: DEFAULT_PRIORITY_WEIGHTS })}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:text-[var(--color-fg)]"
          >
            恢复默认
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-[var(--color-muted)]">本地数据</h3>
        <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs">
          {dbInfo && (
            <>
              <div className="flex gap-2">
                <span className="text-[var(--color-muted)]">数据库</span>
                <span className={dbInfo.ok ? 'text-emerald-400' : 'text-red-400'}>
                  {dbInfo.ok ? `正常 · ${dbInfo.tables} 张表` : '异常'}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="shrink-0 text-[var(--color-muted)]">路径</span>
                <span className="break-all">{dbInfo.path}</span>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => void invoke('search:clearCache', undefined)}
            className="mt-1 rounded border border-[var(--color-border)] px-3 py-1.5 hover:text-[var(--color-fg)]"
          >
            清空搜索缓存
          </button>
        </div>
      </section>
    </div>
  );
}
