import { useEffect, useState } from 'react';
import type { InstalledPlugin } from '@core/plugins/clientView';
import type { SourcePolicy } from '@core/plugins/types';
import { invoke } from '../ipc';

/**
 * 设置页·插入点 C 的展示段：列出已安装岗位包的检索策略（sourcePolicy）。
 *
 * 只读。岗位包策略是包作者的声明，不是用户配置：用户在上方「检索质量与路由」
 * 里手动改过的值永远优先，岗位包只为用户没动过的部分提供岗位默认值
 * （合并规则见 core/src/search/policy.ts）。
 */

interface PackPolicy {
  id: string;
  version: string;
  displayName: string;
  policy: SourcePolicy;
}

async function loadRolePackPolicies(installed: InstalledPlugin[]): Promise<PackPolicy[]> {
  const rolePacks = installed.filter((plugin) => plugin.type === 'role-pack');
  const policies = await Promise.all(
    rolePacks.map(async (plugin): Promise<PackPolicy | null> => {
      try {
        const pack = await invoke('plugin:getRolePack', {
          id: plugin.id,
          version: plugin.version,
        });
        if (!pack) return null;
        return {
          id: pack.manifest.id,
          version: pack.manifest.version,
          displayName: pack.manifest.displayName,
          policy: pack.sourcePolicy,
        };
      } catch {
        // 单个包拉取失败不阻断整段展示
        return null;
      }
    }),
  );
  return policies.filter((policy): policy is PackPolicy => policy !== null);
}

export function PackSearchPolicyPanel(): React.JSX.Element {
  const [policies, setPolicies] = useState<PackPolicy[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke('plugin:listInstalled', undefined)
      .then((installed) => loadRolePackPolicies(installed))
      .then((loaded) => {
        if (!cancelled) setPolicies(loaded);
      })
      .catch(() => {
        if (!cancelled) setPolicies([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (policies !== null && policies.length === 0) return <></>;

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[var(--color-muted)]">岗位包检索策略</h3>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          已安装岗位包为岗位相关来源声明的默认可信度与时效，只对该岗位的检索生效。
          你在「检索质量与路由」里手动改过的值始终优先，这里只补足你没动过的部分。
        </p>
      </div>
      <div className="space-y-3">
        {policies === null ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs text-[var(--color-muted)]">
            正在读取岗位包策略…
          </div>
        ) : (
          policies.map(({ id, version, displayName, policy }) => (
            <div
              key={`${id}@${version}`}
              className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium">{displayName}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {id}@{version}
                </span>
              </div>
              {policy.preferredDomains.length > 0 && (
                <p className="text-xs text-[var(--color-muted)]">
                  偏好来源：
                  {policy.preferredDomains.map((domain) => (
                    <span key={domain} className="mr-2 inline-block">
                      {domain}
                      {policy.credibilityOverrides?.[domain] !== undefined && (
                        <strong className="ml-0.5">{policy.credibilityOverrides[domain]} 分</strong>
                      )}
                    </span>
                  ))}
                </p>
              )}
              {policy.freshnessDays?.domainKnowledge !== undefined && (
                <p className="text-xs text-[var(--color-muted)]">
                  领域知识过时门槛 {policy.freshnessDays.domainKnowledge} 天
                  {policy.freshnessDays?.companyIntel !== undefined &&
                    ` · 公司情报缓存 ${policy.freshnessDays.companyIntel} 天`}
                  {policy.freshnessDays?.interviewReports !== undefined &&
                    ` · 面经缓存 ${policy.freshnessDays.interviewReports} 天`}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
