/**
 * §6「基础包岗位中立」三条判据的静态关卡（分发计划 §11 阶段 0 的交付物）。
 *
 * 判据本身写在 §6：基础包的源码里
 *   1. 不出现岗位簇名词（能力 id 字面量、`repo` / `rolePlay` / 案例表格这类域名词）；
 *   2. 不出现岗位专属的通道名、表名、枚举取值；
 *   3. 渲染层的桥方法表不硬编码岗位簇方法。
 *
 * 三条合起来是一条整链结论——「基础包里还留着多少岗位簇实现」。没有哪个单点测试会因为
 * 链子断在这里而失败：`repo:*` 通道全部跑通、岗位包全绿、界面全绿，基础包里照样能躺着
 * 1.4k 行软件工程实现。所以这里直接扫源码，把越界点定位到具体文件与行数（§11.1 那张表）。
 *
 * 关卡是**先冻结、再收缩**：§11.1 的越界点先落成名单（FROZEN_OFFENDERS），出现名单之外
 * 的新命中就红，名单里的条目不再命中（或命中次数变了）也红。搬迁每删掉一处，就在名单里
 * 同步删掉那一条——名单的长度就是搬迁进度。名单里刻意不写「允许」，写的是「还没搬」。
 *
 * 扫描范围是三个应用源码根：core/src、desktop/src、mobile/src。岗位包数据住在仓库顶层
 * `plugins/`，示例在 `examples/`，两者都不在这三个根下，所以是构造上出局，不靠这里排除。
 * `*.test.ts(x)` 与被扫的关卡自己按文件名跳过；夹具（__fixtures__）**在**扫描范围内——
 * 它们随 src 一起进包，也是基础包源码。
 *
 * 不并进旁边的 roleAgnosticUi.test.ts：那份只扫渲染进程、守的是「界面只消费 descriptor」，
 * 是渲染层的单包约束；这条跨 core / desktop / mobile 三包、守的是 §6 的基础包边界，
 * 扫法与 desktop/src/main/plugins/basePackage.test.ts 同源（都是按路径读文本，不 import，
 * 所以 core 不会因为这条关卡反向依赖 desktop / mobile）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Criterion = 1 | 2 | 3;

/** 越界点归属的岗位簇，用 §11.1 那张表的说法 */
type RoleCluster = '软件工程' | '产品经理' | '销售客服' | '跨岗' | '软件工程/产品经理/销售客服';

interface CriterionRule {
  /** 名单里的键名，也是报错时的定位名 */
  id: string;
  criterion: Criterion;
  /** 命中归属的岗位簇 */
  cluster: RoleCluster;
  /** 命中原因，写给人看 */
  reason: string;
  pattern: RegExp;
  /** 同形异义文件：这个规则在它们身上的命中不是岗位簇味道（见 SAME_SHAPE_FILES） */
  exceptFiles?: readonly string[];
}

interface Source {
  /** 相对仓库根的路径，正斜杠 */
  file: string;
  text: string;
}

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCOPE_ROOTS = ['core/src', 'desktop/src', 'mobile/src'] as const;
/** 构建产物与依赖不是源码，不进扫描 */
const SKIP_DIR = /(^|[\\/])(node_modules|dist|out|coverage)([\\/]|$)/;

function relativeToRepo(path: string): string {
  return path.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
}

function collectSources(root: string, found: Source[] = []): Source[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (SKIP_DIR.test(path)) continue;
    if (entry.isDirectory()) {
      collectSources(path, found);
      continue;
    }
    // 只扫源码：测试文件（含这个关卡自己）按文件名出局
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    found.push({ file: relativeToRepo(path), text: readFileSync(path, 'utf8') });
  }
  return found;
}

const SOURCES: readonly Source[] = SCOPE_ROOTS.map((root) => join(REPO_ROOT, root)).flatMap(
  (root) => collectSources(root),
);

/**
 * `repo` 的同形异义：**发布仓库**（GitHub release repo、Hugging Face 模型仓库）。
 * 这些文件里的 repo 是「下载源」，不是软件工程岗位簇的「代码仓库」。按文件排除，而不是
 * 让它们进名单——名单是给搬迁用的进度表，塞进不会被搬掉的误报只会让关卡失去意义。
 */
const SAME_SHAPE_FILES: readonly string[] = [
  'core/src/updateFeed.ts',
  'desktop/src/main/updater.ts',
  'desktop/src/main/releaseList.ts',
  'desktop/src/main/plugins/catalog.ts',
  'desktop/src/main/stt/index.ts',
  'mobile/src/update/appUpdate.ts',
];

/**
 * 升级兼容代码：把 0.6.x 旧库整体搬进新结构时，必须**点名**旧列名（`repo_id`、
 * `tech_stack_md`）才能按 RENAME 把取值映射过去。这些名字是历史数据的一部分，搬不掉，
 * 更不是「基础包里还留着岗位簇实现」——塞进 FROZEN_OFFENDERS（搬迁进度表）只会留下
 * 永不消失的误报，所以按文件出局。夹具（`__fixtures__/legacy06/`）是 .sql / .json，
 * 本来就不在扫描范围内。
 */
const UPGRADE_COMPAT_FILES: readonly string[] = [
  'desktop/src/main/db/legacyImport.ts',
  // 补齐旧仓库登记行的本机检出：要按旧表名取 local_path，再按包工作区改名搬过去
  'desktop/src/main/db/backfill/legacyRepoCheckouts.ts',
];

/**
 * 每一条判据的命中口径。正则一律带词边界或字面量形状，避免误伤普通英文词：
 * `\brepo` 不吃 `report` / `repository`，`EXAM_FORMS` 与 `REPO_STATUSES` 分开成常量名，
 * 岗位包条目 id 只认带引号的 `se.` / `pm.` / `sales.` 前缀字面量。
 */
const RULES: readonly CriterionRule[] = [
  // ── 判据一：岗位簇名词与能力 id 字面量 ─────────────────────────────────
  {
    id: 'repoNoun',
    criterion: 1,
    cluster: '软件工程',
    reason: '代码仓库域名词（repo / repos / Repo / RepoWorkspace / repoId…）',
    pattern: /\brepos?[A-Z_]\w*|\b(?:repo|repos|Repo|Repos)\b/g,
    exceptFiles: SAME_SHAPE_FILES,
  },
  {
    id: 'codeRefNoun',
    criterion: 1,
    cluster: '软件工程',
    reason: '行内代码引用域名词（codeRef / codeRefs）',
    pattern: /\bcodeRef\w*/g,
  },
  {
    id: 'designCaseNoun',
    criterion: 1,
    cluster: '产品经理',
    reason: '产品案例域名词（designCase）',
    pattern: /\bdesignCase\w*/g,
  },
  {
    id: 'tabularDataset',
    criterion: 1,
    cluster: '产品经理',
    reason: '案例表格契约名（tabular-dataset）',
    pattern: /tabular-dataset/g,
  },
  {
    id: 'rolePlayNoun',
    criterion: 1,
    cluster: '销售客服',
    reason: '角色扮演域名词（rolePlay / rolePlaySession / rolePlayRunner）',
    pattern: /\brolePlay\w*/g,
  },
  {
    id: 'readCodeNoun',
    criterion: 1,
    cluster: '跨岗',
    reason: '读源码任务种类名词（readCode）',
    pattern: /\breadCode\w*/g,
  },
  {
    id: 'capabilityIdLiteral',
    criterion: 1,
    cluster: '软件工程/产品经理/销售客服',
    reason: '岗位包声明的能力 id 字面量',
    pattern: /['"](?:source-repository|analytics-case|renewal-at-risk)['"]/g,
  },
  {
    id: 'rolePackIdLiteral',
    criterion: 1,
    cluster: '跨岗',
    reason: '岗位包 id 字面量',
    pattern: /['"](?:software-engineering|product-manager|sales-customer-success)['"]/g,
  },
  {
    id: 'packItemIdLiteral',
    criterion: 1,
    cluster: '跨岗',
    reason: '岗位包声明的题型 / 量规 / 任务 id 字面量（se. / pm. / sales. 前缀）',
    pattern: /['"](?:se|pm|sales)\.[a-z]/g,
  },
  {
    id: 'prePluginDefaultRolePack',
    criterion: 1,
    cluster: '跨岗',
    reason: '岗位兜底常量（插件化之前默认落在软件工程岗）',
    pattern: /\bPRE_PLUGIN_DEFAULT_ROLE_PACK_ID\b/g,
  },
  {
    id: 'repositoryPermission',
    criterion: 1,
    cluster: '软件工程',
    reason: '岗位味权限词汇 repository:read（§11.2 点名随原语化退掉）',
    pattern: /repository:read/g,
  },

  // ── 判据二：岗位专属的通道名、表名与枚举取值 ────────────────────────────
  {
    id: 'repoChannel',
    criterion: 2,
    cluster: '软件工程',
    reason: '源码仓库通道（repo:*）',
    pattern: /['"]repo:/g,
  },
  {
    id: 'codeRefChannel',
    criterion: 2,
    cluster: '软件工程',
    reason: '代码引用通道（codeRef:*）',
    pattern: /['"]codeRef:/g,
  },
  {
    id: 'designChannel',
    criterion: 2,
    cluster: '产品经理',
    reason: '案例通道（design:*）',
    pattern: /['"]design:/g,
  },
  {
    id: 'rolePlayChannel',
    criterion: 2,
    cluster: '销售客服',
    reason: '角色扮演通道（interaction:*RolePlay）',
    pattern: /['"]interaction:[^'"]*RolePlay[^'"]*['"]/g,
  },
  {
    id: 'annotationListForRepo',
    criterion: 2,
    cluster: '软件工程',
    reason: '按源码仓库取批注的通道（annotation:listForRepo）',
    pattern: /annotation:listForRepo/g,
  },
  {
    id: 'sweTableName',
    criterion: 2,
    cluster: '软件工程',
    reason: '软件工程表名（repo / repo_file / code_ref）',
    pattern: /\brepo_file\b|\bcode_ref\b|['"]repo['"]/g,
  },
  {
    id: 'pmTableName',
    criterion: 2,
    cluster: '产品经理',
    reason: '产品经理表名（design_case）',
    pattern: /\bdesign_case\b/g,
  },
  {
    id: 'techStackColumn',
    criterion: 2,
    cluster: '跨岗',
    reason: '岗位专属列（company_intel.tech_stack_md）',
    pattern: /\btech_stack_md\b/g,
  },
  {
    id: 'examFormsConstant',
    criterion: 2,
    cluster: '软件工程',
    reason: '题型枚举常量（EXAM_FORMS）',
    pattern: /\bEXAM_FORMS\b/g,
  },
  {
    id: 'repoStatusesConstant',
    criterion: 2,
    cluster: '软件工程',
    reason: '仓库状态枚举常量（REPO_STATUSES）',
    pattern: /\bREPO_STATUSES\b/g,
  },
  {
    id: 'roleEnumValue',
    criterion: 2,
    cluster: '跨岗',
    reason: '岗位取值字面量（repoQa / readCode / codeRef / design）',
    pattern: /['"](?:repoQa|readCode|codeRef|design)['"]/g,
  },

  // ── 判据三：桥方法表里的岗位簇方法 ─────────────────────────────────────
  {
    id: 'bridgeMethodEntry',
    criterion: 3,
    cluster: '软件工程',
    reason: '桥方法表里硬编码的岗位簇方法名（methods[\'repo.x\'] / case \'repo.x\'）',
    pattern: /(?:methods\s*\[\s*['"]|case\s+['"])(?:repo|codeRef|design|rolePlay|readCode)\.[A-Za-z][^'"]*['"]/g,
  },
];

interface Hit {
  file: string;
  rule: string;
  count: number;
}

/** 扫一遍源码，按「文件 + 规则」记命中次数。 */
function collectHits(): Hit[] {
  const hits: Hit[] = [];
  for (const source of SOURCES) {
    if (UPGRADE_COMPAT_FILES.includes(source.file)) continue;
    for (const rule of RULES) {
      if (rule.exceptFiles?.includes(source.file)) continue;
      rule.pattern.lastIndex = 0;
      const count = [...source.text.matchAll(rule.pattern)].length;
      if (count > 0) hits.push({ file: source.file, rule: rule.id, count });
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

const HITS: readonly Hit[] = collectHits();

/**
 * §11.1 的越界点，逐条冻结：`规则 id → [文件, 命中次数]`。
 *
 * 这些条目是「还没搬走」的岗位簇实现，不是「允许出现」。`count` 是两条用例的锚：
 * 命中变多说明又抄了一处进来，命中变少说明搬了但没同步收缩清单，两种都要红。
 */
const FROZEN_OFFENDERS: Readonly<Record<string, readonly (readonly [string, number])[]>> = {
  // 判据一 · 软件工程
  repoNoun: [
    ['core/src/planner/__fixtures__/prePluginPlan.ts', 10],
    ['core/src/plugins/__fixtures__/phase0Campaign.ts', 7],
    ['core/src/plugins/__fixtures__/phase1Campaign.ts', 1],
    ['desktop/src/main/db/schema.ts', 15],
    // 0027_task_material（随移动端迁移 bundle 打包）新增两处旧列名 repo_id：
    // 注释一处、`RENAME COLUMN repo_id TO material_id` 一处。旧表本身仍在（回退路径）。
    ['mobile/src/db/migrations/bundle.ts', 17],
  ],
  // 旧源码引用表的定义仍留在 schema 里（回退路径），源码里不再出现该域名词。
  codeRefNoun: [['desktop/src/main/db/schema.ts', 1]],
  // 旧模拟面试题表的 JS 侧标识改成中立名（SQL 表名保持不变），源码里不再出现案例域名词。
  designCaseNoun: [],
  // 案例表格契约与解析已随产品经理岗位包分发（plugins/productManager/desktop/ui/case-data.ts）
  tabularDataset: [],
  // 客户对话模拟已随岗位包分发（plugins/salesCustomerSuccess/desktop/ui/role-play.html）：
  // 宿主侧的 session / interactionRuntime / RolePlayRunner 与对应的 IPC 通道全部下线。
  rolePlayNoun: [],
  readCodeNoun: [
    ['core/src/planner/__fixtures__/prePluginPlan.ts', 1],
    ['core/src/plugins/__fixtures__/phase0Campaign.ts', 3],
  ],
  capabilityIdLiteral: [],
  // 手机端排程的旧战役兜底包改由 selectPrePluginRolePack 按包的声明形状选出，
  // 源码里不再出现岗位包 id 字面量，名单因此清空；保留这条规则守住「不许再抄回来」。
  rolePackIdLiteral: [],
  packItemIdLiteral: [['core/src/competency/__fixtures__/productManagementRolePack.ts', 14]],
  // 岗位兜底常量已删除（§6 判据一：基础包不再点名任何岗位族）。「迁移前的旧战役属于哪个包」
  // 改由 selectPrePluginRolePack / isPrePluginRolePack 按包声明的形状回答，源码里不再出现该常量，
  // 名单因此清空；保留这条规则是为了守住「常量不许再被抄回来」。
  prePluginDefaultRolePack: [],
  repositoryPermission: [],

  // 判据二 · 软件工程 / 产品经理 / 跨岗
  repoChannel: [],
  codeRefChannel: [],
  designChannel: [],
  // interaction:*RolePlay 通道随宿主侧实现一并删除，通道名不再出现在基础包里。
  rolePlayChannel: [],
  annotationListForRepo: [],
  // 旧平台那三张表的定义仍留在 schema 里（回退路径），所以这里只剩 schema 与历史夹具：
  // 数据面本身已经改走岗位包声明的数据集合，源码里不再出现按表名读写。
  sweTableName: [
    ['core/src/plugins/__fixtures__/phase1Campaign.ts', 1],
    ['desktop/src/main/db/schema.ts', 3],
    ['mobile/src/db/migrations/bundle.ts', 5],
  ],
  // 旧模拟面试题表只剩 schema 里的表名与迁移 bundle（baseline 建表 + 两次 ALTER）：
  // 宿主不再按表名读写权威数据，历史投影的表名从 schema 反射。
  pmTableName: [
    ['desktop/src/main/db/schema.ts', 1],
    ['mobile/src/db/migrations/bundle.ts', 4],
  ],
  // company_intel 的岗位专属列名已换成岗位中立的一列；旧名只剩手机端迁移 bundle 里
  // 的两处（baseline 建表一处、0028 改名一处）。桌面端迁移是 .sql，不在扫描范围内。
  techStackColumn: [['mobile/src/db/migrations/bundle.ts', 2]],
  // 题型取值已改由岗位包 examForms 声明，基础包里不再有题型枚举常量；这条规则保留
  // 是为了守住「常量不许再被抄回来」，名单因此清空。
  examFormsConstant: [],
  repoStatusesConstant: [],
  // 岗位取值字面量只剩历史夹具里的题型 / 任务取值：它们模拟插件化之前的行，不能改。
  // 宿主侧的写入、读取与只读投影都已改走中性取值，或按表形状兜底，源码里不再出现这些取值。
  roleEnumValue: [
    ['core/src/planner/__fixtures__/prePluginPlan.ts', 1],
    ['core/src/plugins/__fixtures__/phase0Campaign.ts', 2],
  ],

  // 判据三 · 渲染层桥方法表：**已清空**。桥方法只剩下「包声明 ∩ 本端通用原语表」这一条
  // 来源，渲染层不再按权限整段放行岗位簇方法。
  bridgeMethodEntry: [],
};

const FROZEN_HITS: readonly Hit[] = Object.entries(FROZEN_OFFENDERS).flatMap(([rule, entries]) =>
  entries.map(([file, count]) => ({ file, rule, count })),
);

function ruleOf(id: string): CriterionRule {
  const rule = RULES.find((item) => item.id === id);
  if (!rule) throw new Error(`名单里出现了未知规则：${id}`);
  return rule;
}

/** `${文件} :: ${规则}` → 命中次数 */
function indexHits(hits: readonly Hit[], criterion: Criterion): Map<string, number> {
  return new Map(
    hits
      .filter((hit) => ruleOf(hit.rule).criterion === criterion)
      .map((hit) => [`${hit.file} :: ${hit.rule}`, hit.count] as const),
  );
}

const ACTUAL: Readonly<Record<Criterion, Map<string, number>>> = {
  1: indexHits(HITS, 1),
  2: indexHits(HITS, 2),
  3: indexHits(HITS, 3),
};

const FROZEN: Readonly<Record<Criterion, Map<string, number>>> = {
  1: indexHits(FROZEN_HITS, 1),
  2: indexHits(FROZEN_HITS, 2),
  3: indexHits(FROZEN_HITS, 3),
};

/** 计数对不上的条目，两侧数字都报出来，才能一眼看出是新增还是搬迁没同步 */
function diff(
  criterion: Criterion,
  worse: (actualCount: number, frozenCount: number) => boolean,
): string[] {
  const actual = ACTUAL[criterion];
  const frozen = FROZEN[criterion];
  return [...new Set([...actual.keys(), ...frozen.keys()])]
    .filter((key) => worse(actual.get(key) ?? 0, frozen.get(key) ?? 0))
    .map((key) => `${key}：源码 ${actual.get(key) ?? 0} 处，名单 ${frozen.get(key) ?? 0} 处`)
    .sort();
}

/** 名单之外的新命中（命中变多也算）——这是关卡的主要作用 */
function newHits(criterion: Criterion): string[] {
  return diff(criterion, (actualCount, frozenCount) => actualCount > frozenCount);
}

/** 名单里已经不再命中（命中变少也算）——逼着搬迁时同步收缩名单 */
function staleHits(criterion: Criterion): string[] {
  return diff(criterion, (actualCount, frozenCount) => actualCount < frozenCount);
}

describe('基础包岗位中立（§6 三条判据）', () => {
  it('扫到了三个应用源码根，否则下面三条判据都是空跑', () => {
    const files = SOURCES.map((source) => source.file);
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain('core/src/ipc.ts');
    expect(files).toContain('desktop/src/renderer/src/App.tsx');
    expect(files).toContain('mobile/src/data/queries.ts');
    // 岗位包数据与示例在另外两个根下，不该被算成基础包源码
    expect(files.filter((file) => file.startsWith('plugins/') || file.startsWith('examples/'))).toEqual(
      [],
    );
    expect(files.filter((file) => file.includes('.test.'))).toEqual([]);
  });

  it('名单是闭集合：规则名与代码里的一致，加规则必须同步加名单', () => {
    expect(Object.keys(FROZEN_OFFENDERS).sort()).toEqual(RULES.map((rule) => rule.id).sort());
  });

  it('判据一：基础包源码里不出现岗位簇名词（能力 id 字面量、repo / rolePlay / 案例表格这类域名词）', () => {
    expect(newHits(1)).toEqual([]);
  });

  it('判据二：基础包源码里不出现岗位专属的通道名、表名与枚举取值', () => {
    expect(newHits(2)).toEqual([]);
  });

  it('判据三：渲染层的桥方法表不硬编码岗位簇方法', () => {
    expect(newHits(3)).toEqual([]);
  });

  it('名单没有陈旧条目：在册的每一条都仍然命中，且命中次数没变', () => {
    expect([...staleHits(1), ...staleHits(2), ...staleHits(3)]).toEqual([]);
  });
});

/**
 * 这份名单是 §11.1「现状盘点」的可执行形态：每一行都是一个还没搬走的岗位簇实现，
 * 不是一条豁免。收缩方式只有一个方向——把实现搬进对应岗位包（或换成通用原语）之后，
 * 在 FROZEN_OFFENDERS 里删掉那一条，命中次数随之归零；忘了删，上面的「陈旧条目」
 * 用例会红。反过来说，任何一条新命中都会让对应判据的用例红，所以名单只会变短。
 */
