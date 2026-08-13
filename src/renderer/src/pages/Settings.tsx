import { useEffect, useState } from 'react';
import type { AppConfig, PriorityWeights, SearchConfig, UpdateConfig } from '@shared/config';
import { DEFAULT_PRIORITY_WEIGHTS } from '@shared/config';
import { LLM_ROLES, LLM_TIERS, type CoverageType, type LlmRole, type LlmTier } from '@shared/enums';
import type { ProviderTestResult } from '@shared/ipc';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';
import { SecretField } from '../components/SecretField';
import { SearchQualityPanel } from '../components/SearchQualityPanel';
import { UpdatePanel } from '../components/UpdatePanel';
import { SyncPanel } from '../components/SyncPanel';
import { PageShell } from '../components/PageShell';

const TIER_HINTS: Record<LlmTier, string> = {
  main: '主力档：outline / codeAgent / quiz 与全部未映射的角色都走这一档，必须支持 function calling',
  cheap: '便宜档：讲解（explain）专用，调用量最大，是成本大头',
};

const ROLE_HINTS: Record<LlmRole, string> = {
  outline: '生成知识图谱大纲，需要结构化能力，用量小',
  explain: '生成三档讲解，调用最频繁，是成本大头',
  codeAgent: '源码检索与理解，agent 循环对工具遵循率要求高',
  quiz: '出题与评分，需要稳定的评判尺度',
  resumeOptimize: '简历定向优化：仅基于母版改写表述与结构，不编造事实',
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

/**
 * 一个模型档位：档位配置 + 连通性测试。
 * 测试状态记在按档位取的任务 key 上，切页回来仍显示「测试中…」，结果也会补上。
 */
function TierCard({
  tier,
  tierConfig,
  providers,
  onChange,
}: {
  tier: LlmTier;
  tierConfig: AppConfig['llm']['tiers'][LlmTier];
  providers: AppConfig['llm']['providers'];
  onChange: (patch: Partial<AppConfig['llm']['tiers'][LlmTier]>) => void;
}): React.JSX.Element {
  const taskKey = `llm:testTier:${tier}`;
  const { running, error } = useTask(taskKey);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  useTaskResult<ProviderTestResult>(taskKey, setTest);

  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-baseline gap-2">
        <code className="text-sm text-sky-300">{tier}</code>
        <span className="text-xs text-[var(--color-muted)]">{TIER_HINTS[tier]}</span>
      </div>
      <div className="flex gap-2">
        <select
          value={tierConfig.providerId}
          onChange={(e) => onChange({ providerId: e.target.value })}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          value={tierConfig.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="模型名，如 deepseek-chat"
          className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() =>
            void runTask(taskKey, () => invoke('llm:testTier', { tier })).catch(() => undefined)
          }
          disabled={running}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {running ? '测试中…' : '测试'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {test && (
        <p className={`text-xs ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {test.ok ? `${test.latencyMs}ms · ` : ''}
          {test.message}
        </p>
      )}
    </div>
  );
}

export function Settings(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saved, setSaved] = useState(false);
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

const updateTier = (tier: LlmTier, patch: Partial<AppConfig['llm']['tiers'][LlmTier]>): void => {
  void persist({ ...config, llm: { ...config.llm, tiers: { ...config.llm.tiers, [tier]: { ...config.llm.tiers[tier], ...patch } } } });
};

const updateRoleTier = (role: LlmRole, tier: LlmTier): void => {
  void persist({ ...config, llm: { ...config.llm, roles: { ...config.llm.roles, [role]: tier } } });
};

const updateEmbedding = (patch: Partial<AppConfig['llm']['embedding']>): void => {
  void persist({ ...config, llm: { ...config.llm, embedding: { ...config.llm.embedding, ...patch } } });
};

  const updatePriority = (patch: Partial<PriorityWeights>): void => {
    void persist({ ...config, priority: { ...config.priority, ...patch } });
  };

  const updateSearch = (patch: Partial<SearchConfig>): void => {
    void persist({ ...config, search: { ...config.search, ...patch } });
  };

  const updateUpdater = (patch: Partial<UpdateConfig>): void => {
    void persist({ ...config, update: { ...config.update, ...patch } });
  };

  return (
    <PageShell className="space-y-8">
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
          <h3 className="text-sm font-medium text-[var(--color-muted)]">模型档位</h3>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            档位定义模型，角色只做映射。只配「主力档」即可完整运行，便宜档是可选的成本优化。
          </p>
        </div>

        {LLM_TIERS.map((tier) => (
          <TierCard
            key={tier}
            tier={tier}
            tierConfig={config.llm.tiers[tier]}
            providers={config.llm.providers}
            onChange={(patch) => updateTier(tier, patch)}
          />
        ))}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-[var(--color-muted)]">角色映射</h3>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            每个角色指定走哪个档位。未列出的角色默认走「主力」档。
          </p>
        </div>

        {LLM_ROLES.map((role) => (
          <div
            key={role}
            className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          >
            <code className="w-24 shrink-0 text-sm text-sky-300">{role}</code>
            <span className="flex-1 text-xs text-[var(--color-muted)]">{ROLE_HINTS[role]}</span>
            <select
              value={config.llm.roles[role] ?? 'main'}
              onChange={(e) => updateRoleTier(role, e.target.value as LlmTier)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none"
            >
              {LLM_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium text-[var(--color-muted)]">Embedding（固定）</h3>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            向量化模型不参与档位选择：一旦切换，已有图谱与真题向量全部失效。换模型前请想清楚。
          </p>
        </div>
        <div className="flex gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <select
            value={config.llm.embedding.providerId}
            onChange={(e) => updateEmbedding({ providerId: e.target.value })}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none"
          >
            {config.llm.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            value={config.llm.embedding.model}
            onChange={(e) => updateEmbedding({ model: e.target.value })}
            placeholder="如 text-embedding-3-small"
            className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>
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

      <SearchQualityPanel value={config.search} onChange={updateSearch} />

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

      <UpdatePanel value={config.update} onChange={updateUpdater} />

      <SyncPanel />

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
    </PageShell>
  );
}
