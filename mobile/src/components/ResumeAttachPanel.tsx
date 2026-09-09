import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { getRawDb } from '../db';
import { diagnoseAttachResume } from '../data/diagnosisLocal';
import { getPeerCreds, runDesktopJob } from '../remote/rpc';
import { runTask, useTaskState } from '../context/RemoteTaskContext';
import { useTheme } from '../theme';

interface ResumeOption {
  id: string;
  label: string;
}

/**
 * 关联简历并交叉分析。
 *
 * 备考只能在新建时绑一次简历，之后既换不了也没法重跑分析——而简历恰恰是一直在改的那份
 * 东西：投之前改一版、面完再改一版。绑定本身让出题和参考答案能结合履历，交叉分析则把考点
 * 重新分成必深挖/短板/雷区/加分项，这一步不重跑，考点覆盖类型就一直停在旧简历上。
 *
 * 两条路都给：本机跑（离线可用，用手机上配的模型）或交给桌面端跑。桌面端那条不是冗余——
 * 手机上可能压根没配模型，而且桌面端常配着更强的模型，跑的是同一条管道。
 */
export function ResumeAttachPanel({
  campaignId,
  onDone,
}: {
  campaignId: string;
  onDone?: () => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const taskKey = `campaign:${campaignId}:attachResume`;
  const { running, error } = useTaskState(taskKey);

  const db = getRawDb();
  const resumes = db.getAllSync<ResumeOption>(
    `SELECT id, label FROM resume ORDER BY updated_at DESC, created_at DESC`,
  );
  const boundId =
    db.getFirstSync<{ resume_id: string | null }>(
      `SELECT resume_id FROM campaign WHERE id = ?`,
      campaignId,
    )?.resume_id ?? null;
  const bound = resumes.find((r) => r.id === boundId) ?? null;
  const paired = getPeerCreds() !== null;

  if (resumes.length === 0) {
    return (
      <Text style={{ color: theme.muted, fontSize: 12 }}>
        暂无简历：可在「简历」页导入，或从桌面端同步过来后再关联
      </Text>
    );
  }

  const attach = (resumeId: string, viaDesktop: boolean): void => {
    void runTask(taskKey, viaDesktop ? '桌面端交叉分析' : '简历交叉分析', async () => {
      const message = viaDesktop
        ? await runDesktopJob('diagnosis:attachResume', { campaignId, resumeId })
        : await diagnoseAttachResume(db, campaignId, resumeId);
      setExpanded(false);
      onDone?.();
      return message;
    }).catch(() => undefined);
  };

  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={() => setExpanded((prev) => !prev)}
        disabled={running}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <Text style={{ color: theme.text, fontSize: 13 }}>
          关联简历{bound ? ` · ${bound.label}` : '（未关联）'}
        </Text>
        <Text style={{ color: theme.accent, fontSize: 12 }}>
          {running ? '分析中…' : expanded ? '收起' : '更换'}
        </Text>
      </Pressable>

      {!bound && !expanded && (
        <Text style={{ color: theme.muted, fontSize: 11 }}>
          关联后出题与参考答案会结合你的履历，并据此重算考点的覆盖类型
        </Text>
      )}

      {error && <Text style={{ color: theme.danger, fontSize: 12 }}>{error}</Text>}

      {expanded && (
        <View style={{ gap: 8 }}>
          {resumes.map((resume) => (
            <View key={resume.id} style={{ gap: 2 }}>
              <Text
                style={{
                  color: resume.id === boundId ? theme.accent : theme.text,
                  fontSize: 13,
                }}
              >
                {resume.label}
                {resume.id === boundId ? ' · 当前' : ''}
              </Text>
              <View style={{ flexDirection: 'row', gap: 14 }}>
                <Pressable disabled={running} onPress={() => attach(resume.id, false)}>
                  <Text style={{ color: theme.accent, fontSize: 11, opacity: running ? 0.5 : 1 }}>
                    本机分析
                  </Text>
                </Pressable>
                <Pressable
                  disabled={running || !paired}
                  onPress={() => attach(resume.id, true)}
                >
                  <Text
                    style={{
                      color: paired ? theme.accent : theme.muted,
                      fontSize: 11,
                      opacity: running ? 0.5 : 1,
                    }}
                  >
                    {paired ? '交给桌面端' : '交给桌面端（未配对）'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
