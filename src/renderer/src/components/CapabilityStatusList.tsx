import type { CapabilityRow } from '@shared/hostUi';
import { CAPABILITY_MODE_LABELS } from '@shared/hostUi';
import type { ClientCapabilityMode } from '@shared/plugins/clientView';

const MODE_STYLE: Record<ClientCapabilityMode, string> = {
  full: 'bg-emerald-900/40 text-emerald-300',
  'view-only': 'bg-amber-900/40 text-amber-200',
  unsupported: 'bg-red-950/40 text-red-300',
};

/**
 * 能力插件清单。
 *
 * 每一行分开说两件事，因为它们的处置方式完全不同：「这场备考启没启用」是用户自己能改的
 * 勾选，「本机能不能跑」是这台设备的状态，勾了也不会变。混成一个「可用/不可用」标签，
 * 用户只会反复去点那个勾不动的复选框。
 *
 * 本机没装的插件不给勾：descriptor 会照样把它记下来，但这台机器上点进去必然报错，
 * 让用户先勾上再被拒绝，不如一开始就说清楚。
 */
export function CapabilityStatusList({
  rows,
  selectedIds,
  onToggle,
}: {
  rows: CapabilityRow[];
  selectedIds: string[];
  onToggle: (id: string, checked: boolean) => void;
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-[var(--color-muted)]">
        本机没有安装任何能力插件，这场备考只用岗位包自带的题型与量规。
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li
          key={row.id}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
        >
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={selectedIds.some((id) => id === row.id)}
              disabled={!row.installedLocally}
              onChange={(e) => onToggle(row.id, e.target.checked)}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm">{row.displayName}</span>
                {row.version && (
                  <span className="text-[10px] text-[var(--color-muted)]">v{row.version}</span>
                )}
                {row.localMode && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${MODE_STYLE[row.localMode]}`}
                  >
                    本机{CAPABILITY_MODE_LABELS[row.localMode]}
                  </span>
                )}
                {!row.installedLocally && (
                  <span className="rounded bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-300">
                    本机未安装
                  </span>
                )}
                {!row.enabledInCampaign && (
                  <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
                    本次未启用
                  </span>
                )}
              </span>
              {row.description && (
                <span className="mt-0.5 block text-[10px] text-[var(--color-muted)]">
                  {row.description}
                </span>
              )}
              {row.disabledReason && (
                <span className="mt-0.5 block text-[10px] text-amber-300">
                  未启用原因：{row.disabledReason}
                </span>
              )}
              {row.localDetail && (
                <span className="mt-0.5 block text-[10px] text-amber-300">{row.localDetail}</span>
              )}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
