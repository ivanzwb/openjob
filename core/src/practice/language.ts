/**
 * 练习的「面试语言」。
 *
 * 0.6.x 的自我介绍旁边有一条中文 / 英文的选择，其余题型一律按包的中文正文走（它对别的
 * 题型强制 zh）。这里沿用同一套取值、同一个默认值与同一句措辞。
 *
 * 语言**不改正文**，只在问模型时追加一句：题型片段、量规锚点、引文规则都与语言无关，
 * 为英文再抄一份正文等于多出一份要跟着改的东西。真正会跟着变的是模型输出的题目、追问、
 * 评分反馈与改进稿——那正是那句指令点名的四件事。
 */
export const INTERVIEW_LANGUAGES = ['zh', 'en'] as const;

export type InterviewLanguage = (typeof INTERVIEW_LANGUAGES)[number];

/** 默认中文：缺省、意外取值、旧数据都落到它，与 0.6.x 的默认一致。 */
export const DEFAULT_INTERVIEW_LANGUAGE: InterviewLanguage = 'zh';

/** 练习页上那两个选项，标签沿用 0.6.x 的写法。 */
export const INTERVIEW_LANGUAGE_CHOICES: { value: InterviewLanguage; label: string }[] = [
  { value: 'zh', label: '中文面试' },
  { value: 'en', label: '英文面试' },
];

/** 取值收敛：只认 en，其余一律中文（界面传了别的东西也不该把中文面试变成英文）。 */
export function normalizeInterviewLanguage(value: unknown): InterviewLanguage {
  return value === 'en' ? 'en' : 'zh';
}

/** 追加给模型的语言指令，措辞逐字沿用 0.6.x。 */
export function interviewLanguageInstruction(language: unknown): string {
  return normalizeInterviewLanguage(language) === 'en'
    ? '请用英文模拟真实面试：题目、追问、评分反馈和改进稿都使用英文。'
    : '请用中文模拟真实面试：题目、追问、评分反馈和改进稿都使用中文。';
}
