import { useEffect, useState } from 'react';
import type { ResumeModuleDefinition } from '@core/plugins/types';
import type { ResumeParsed } from '@core/entities';
import { invoke } from '../ipc';

/**
 * 插入点 D 的展示端：按已安装岗位包声明的简历模块，把解析结果里的
 * modules 容器渲染成模块卡（宿主渲染，声明式数据）。
 *
 * 只展示有数据的模块；声明它的岗位包没装时按原始 id 展示——数据比
 * 展示层活得久（简历是母版，岗位包可以换），不能因为包不在就丢数据。
 */

interface ModuleLabels {
  byId: Map<string, ModuleLabel>;
}

interface ModuleLabel extends ResumeModuleDefinition {
  packLabel: string;
}

function renderData(kind: string, data: unknown): React.JSX.Element | null {
  if (kind === 'list' && Array.isArray(data)) {
    if (data.length === 0) return null;
    return (
      <ul className="list-disc space-y-1 pl-5">
        {data.map((item, index) => (
          <li key={index}>{String(item)}</li>
        ))}
      </ul>
    );
  }
  if (kind === 'text' && typeof data === 'string') {
    return <p className="whitespace-pre-wrap">{data}</p>;
  }
  if (data !== null && typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return null;
    return (
      <ul className="space-y-1">
        {entries.map(([key, value]) => (
          <li key={key}>
            <span className="text-[var(--color-muted)]">{key}：</span>
            {String(value)}
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

export function ResumeModulesCard({ parsed }: { parsed: ResumeParsed | null }): React.JSX.Element | null {
  const [labels, setLabels] = useState<ModuleLabels | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke('plugin:listInstalled', undefined)
      .then(async (installed) => {
        const byId = new Map<string, ModuleLabel>();
        for (const plugin of installed.filter((item) => item.type === 'role-pack')) {
          try {
            const pack = await invoke('plugin:getRolePack', { id: plugin.id, version: plugin.version });
            for (const module of pack?.resumeModules ?? []) {
              // 多个包声明同一 id 时后到先得即可：数据键一致，标签取哪个包都成立
              if (!byId.has(module.id)) {
                byId.set(module.id, { ...module, packLabel: plugin.displayName });
              }
            }
          } catch {
            // 单个包拉取失败不影响其余标签
          }
        }
        return { byId };
      })
      .then((loaded) => {
        if (!cancelled) setLabels(loaded);
      })
      .catch(() => {
        if (!cancelled) setLabels({ byId: new Map() });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const modules = parsed?.modules ?? {};
  const entries = Object.entries(modules);
  if (entries.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-[var(--color-muted)]">岗位简历模块</h3>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {entries.map(([id, moduleData]) => {
          const known = labels?.byId.get(id);
          // 展示端按 schemaVersion 决定渲染方式；未知版本只显示保留提示，数据不丢
          const knownVersion = known ? known.schemaVersion === moduleData.schemaVersion : false;
          const body = known && knownVersion ? renderData(known.kind, moduleData.data) : null;
          return (
            <div
              key={id}
              className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{known?.label ?? id}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {known ? known.packLabel : '未安装的岗位包'}
                </span>
              </div>
              {body ?? (
                <p className="text-xs text-[var(--color-muted)]">
                  该模块数据已保留（schemaVersion {moduleData.schemaVersion}），当前版本暂不支持展示。
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
