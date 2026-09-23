/**
 * E132 手机端（React Native）——8 个页面的功能覆盖。
 *
 * 驱动走 adb（手机端没有 CDP 可连）：抓界面树 → 读文本与坐标 → 点。要起模拟器、装 126MB 的包，
 * 所以**默认不跑**（`E2E_MOBILE=1` 才跑），且依赖本机有 AVD。
 *
 * **数据全部由应用自己造**（备考页的「创建备考职位」、简历页的「粘贴文本新建简历」），
 * 不依赖与桌面端配对——模拟器没有摄像头，扫码这条路走不通（见 E132i）。
 *
 * **顺序即用例**：一个 `describe` 里共享同一份应用数据，后面的用例建立在前面的创建结果上
 * （面试页要先有备考才给题型/语言）。因此 `beforeAll` 里会 `pm clear` 一次，从「刚装完」开始，
 * 保证整段可重复；单跑其中某一条则会缺前置数据而失败，这是设计如此。
 *
 * **弹层要先关**：新建表单是盖住整屏的弹层，一条用例失败留在那里会把后面每条都堵死（看着像
 * 全盘崩溃）。所以每条用例开头都 `closeLayers()`，且失败的用例自己也要收拾干净。
 *
 * **要用当前源码重打的包**：`mobile/dist/OpenJob-<版本>.apk` 是发布落包的地方，但它是
 * `.gitignore` 的、本地不会有人刷新——旧包会让应用永远停在「正在初始化本地数据库…」，
 * 看着像应用起不来。测试台按新旧挑（见 `harness/mobile.ts`），也可用 `E2E_MOBILE_APK` 指定。
 *
 * 输入框只送 ASCII（`adb shell input text` 对中文不可靠），所以造出来的名字是 `E2E-*`。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MobileDevice, mobileAvailable } from '../harness/mobile';

const enabled = process.env['E2E_MOBILE'] === '1';
const available = mobileAvailable();

const CORP = 'E2Ecorp';
const ROLE = 'E2Erole';
const RESUME = 'E2Eresume';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 点第一个能点到的标签（界面文案在不同空态下会变，逐个试比硬编码一个稳） */
function tapAny(device: MobileDevice, labels: string[]): string | null {
  for (const label of labels) {
    if (device.tapText(label)) return label;
  }
  return null;
}

/** 关掉可能盖在屏幕上的弹层，保证每条用例都从能看见页签的状态开始 */
async function closeLayers(device: MobileDevice): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    if (!tapAny(device, ['关闭', '取消'])) break;
    await wait(1200);
  }
}

/** 点第 n 个输入框（手机端表单的输入框没有 resource-id，只能按类名顺序取） */
function tapEditText(device: MobileDevice, index: number): boolean {
  const tags = [...device.dump().matchAll(/<node[^>]*android\.widget\.EditText[^>]*>/g)].map((m) => m[0]);
  const tag = tags[index];
  if (!tag) return false;
  const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
  if (!bounds) return false;
  device.tapAt(
    Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
    Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
  );
  return true;
}

function editTextCount(device: MobileDevice): number {
  return [...device.dump().matchAll(/android\.widget\.EditText/g)].length;
}

describe.skipIf(!enabled || !available)('E132 手机端', () => {
  let device: MobileDevice;

  beforeAll(async () => {
    device = await MobileDevice.boot();
    device.install();
    device.clearData();
    await device.launch();
  }, 600_000);

  afterAll(() => {
    device?.shutdown();
  });

  // 断言一失败就跳到下一条，留在屏幕上的弹层会把后面每条都堵死（看着像全盘崩溃）。
  // 收尾放在这里，单条失败就只影响它自己。
  afterEach(async () => {
    await closeLayers(device);
  });

  it('E132a 应用能起来：过掉首次建库，主页面与五个页签渲染出来', async () => {
    // 首次启动要跑 SQLite 迁移（logcat 里是密集的 major fault），给它时间
    const texts = await device.waitForText('备考', 180_000);
    expect(texts.length).toBeGreaterThan(0);
    // 起崩了会是 ErrorBoundary 或系统弹窗，这里要求看到的是应用自己的页签
    const joined = texts.join(' | ');
    for (const tab of ['总览', '备考', '面试', '简历', '更多']) {
      expect(joined, `底部页签缺 ${tab}`).toContain(tab);
    }
    // 「话术」不在底部（低频功能收进更多页，见 E132g）
    expect(device.clickableTexts()).not.toContain('话术');
  }, 300_000);

  it('E132b 总览：讲清它是干什么的，没有数据时明说是空的', async () => {
    await closeLayers(device);
    device.tapText('总览');
    await device.waitForText('总览', 30_000);
    await wait(2000);

    const joined = device.texts().join(' | ');
    // 这一页的定位（跨战役的真题先验与薄弱点一览）
    expect(joined).toMatch(/薄弱|掌握度|先验/);
    // 空库时明确说是空的、并且指出数据从哪儿来
    expect(joined).toMatch(/暂无|还没有/);
    expect(joined).toMatch(/桌面端|同步|创建/);
  }, 120_000);

  it('E132c 简历：本机粘贴文本就能建，建完出现在列表里', async () => {
    await closeLayers(device);
    device.tapText('简历');
    await device.waitForText('简历', 30_000);
    await wait(1500);

    // 空态要说清两条来路：本机粘贴、或桌面端导入后同步
    const empty = device.texts().join(' | ');
    expect(empty).toMatch(/还没有简历|暂无简历/);
    expect(empty).toMatch(/粘贴/);

    const entry = tapAny(device, ['+ 粘贴文本新建简历', '粘贴文本新建简历', '新建简历']);
    expect(entry, '简历页该有粘贴文本新建的入口').not.toBeNull();
    await wait(2500);

    const form = device.texts().join(' | ');
    expect(form).toMatch(/新建简历|创建|保存/);
    // 表单至少有名字与正文两个输入框
    expect(editTextCount(device)).toBeGreaterThanOrEqual(2);

    // 名字 → 正文 → 提交（软键盘已在 launch 时关掉，不需要按返回收键盘）
    expect(tapEditText(device, 0)).toBe(true);
    device.typeText(RESUME);
    expect(tapEditText(device, 1)).toBe(true);
    device.typeText('E2Eresumebody');
    await wait(1000);

    const submit = tapAny(device, ['创建并编辑', '新建简历', '创建', '保存', '确定']);
    expect(submit, '表单该有一个提交按钮').not.toBeNull();
    await wait(3000);

    // 建完表单要收起来、回到列表；名字必须出现在列表上——只在输入框里出现是假过
    const after = device.texts().join(' | ');
    expect(after, '建完该回到简历列表').not.toMatch(/创建并编辑|粘贴文本新建简历/);
    expect(after).toContain(RESUME);
  }, 180_000);

  it('E132d 备考：本机就能创建备考职位（公司/岗位/JD），建完进详情', async () => {
    await closeLayers(device);
    device.tapText('备考');
    await device.waitForText('备考', 30_000);
    await wait(1500);

    expect(device.texts().join(' | ')).toMatch(/暂无备考/);
    const open = tapAny(device, ['创建备考职位', '创建新职位']);
    expect(open, '备考页该有创建职位的入口').not.toBeNull();
    await wait(2500);

    // 表单：公司 / 岗位 / JD 三个输入框（简历绑定那里没有简历时显示的是「暂无简历」）
    const form = device.texts().join(' | ');
    expect(form).toMatch(/公司/);
    expect(form).toMatch(/岗位/);
    expect(form).toMatch(/JD/);
    expect(form).toMatch(/绑定简历|暂无简历/);
    expect(editTextCount(device)).toBeGreaterThanOrEqual(3);

    for (const [index, value] of [[0, CORP], [1, ROLE], [2, 'E2Ejd']] as const) {
      expect(tapEditText(device, index), `第 ${index} 个输入框点不到`).toBe(true);
      device.typeText(value);
      await wait(600);
    }

    const submit = tapAny(device, ['创建', '创建备考职位', '保存', '确定']);
    expect(submit, '表单该有一个创建按钮').not.toBeNull();
    await wait(3000);

    const list = device.texts().join(' | ');
    expect(list, '建完该出现在备考列表里').toContain(ROLE);

    // 进详情：详情页要有返回，以及考点/情报这类分区之一
    expect(device.tapText(ROLE)).toBe(true);
    await wait(2500);
    const detail = device.texts().join(' | ');
    expect(detail).toMatch(/返回/);
    expect(detail).toMatch(/考点|情报|日历|讲解|考我/);

    device.back();
    await wait(1500);
  }, 240_000);

  it('E132e 面试：有备考之后空态消失，给出题型与面试语言，并能起一场本机练习', async () => {
    await closeLayers(device);
    device.tapText('面试');
    await device.waitForText('面试', 30_000);
    await wait(2000);

    const joined = device.texts().join(' | ');
    // 题型与量规来自同步过来的岗位包，所以本机建的备考不一定会把题型选出来——这里只断言面试页
    // 自己的骨架在（题型、语言、历史练习），以及它有开始练习的入口。
    expect(joined).toMatch(/题型/);
    expect(joined).toMatch(/语言/);
    expect(joined).toMatch(/历史练习/);

    // 起一场：题目由模型生成，没配模型时会明确报错——两种结果都算「按钮真的接上了」，
    // 但绝不能是点了没反应（那才是缺陷）
    const start = tapAny(device, ['开始练习', '继续上次', '考我']);
    expect(start, '面试页该有开始练习的入口').not.toBeNull();
    await wait(8000);
    expect(device.texts().join(' | ')).not.toBe(joined);
  }, 240_000);

  it('E132f 话术：从更多页进入，空态说明话术从哪儿来', async () => {
    await closeLayers(device);
    device.tapText('更多');
    await device.waitForText('更多', 30_000);
    await wait(1500);
    expect(device.tapText('话术'), '更多页该有「话术」入口').toBe(true);
    await wait(2500);

    const joined = device.texts().join(' | ');
    expect(joined).toMatch(/话术/);
    expect(joined).toMatch(/还没有话术|完成考我|源码问答|先/);
  }, 120_000);

  it('E132g 更多页：只有本机已有的入口，插件页要桌面端同步过来才出现；且没有写入口', async () => {
    await closeLayers(device);
    device.tapText('更多');
    await device.waitForText('同步', 60_000);
    await wait(1500);

    const dump = device.dump();
    const texts = device.texts().join(' | ');

    // 「同步」是手机端的定位：数据从桌面端来
    expect(texts).toContain('同步');
    expect(texts).toContain('话术');

    // 还没同步过岗位包，所以插件页（源码）整块不该渲染——不是给个空壳，是不出现
    expect(texts).not.toContain('源码');

    // 「没有写入口」是这条的重点：这里指的是**插件/同步**那类入口不该出现。
    // 备考与简历的创建是本机功能（E132c/E132d 已覆盖），不在这个名单里。
    const writeControls = ['发送', '存为话术', '出题', '开始练习', '标记本页行区间'];
    for (const control of writeControls) {
      expect(dump.includes(`text="${control}"`), `不该出现写入口：${control}`).toBe(false);
    }
  }, 120_000);

  it('E132h 应用更新：入口在，且显示当前版本', async () => {
    await closeLayers(device);
    device.tapText('更多');
    await device.waitForText('更多', 30_000);
    await wait(1500);

    // 更新这块跟版本号、更新源放在一起；入口点得到就点，点不到就说明它在同步页里
    const entry = tapAny(device, ['应用更新', '检查新版本', '检查更新']);
    if (!entry) {
      expect(device.tapText('同步'), '更多页该能进同步页').toBe(true);
      await device.waitForText('同步', 30_000);
      await wait(1500);
    }
    await wait(3000);
    expect(device.texts().join(' | ')).toMatch(/v?\d+\.\d+\.\d+/);
  }, 120_000);

  it('E132i 未配对时的状态是明确的：只给扫码入口，没有手动输入', async () => {
    await closeLayers(device);
    device.tapText('同步');
    const sync = await device.waitForText('未配对', 60_000);
    const joined = sync.join(' | ');

    // 状态明确说清「未配对」以及该去哪儿生成二维码
    expect(joined).toContain('未配对');
    expect(joined).toMatch(/桌面端|二维码/);

    // 配对入口只有扫码：没有输入框——模拟器里扫不了码，这也是「配对后」的状态在手机端
    // 只能靠可调试包 + 预置库、而不能靠真配对来覆盖的原因
    const xml = device.dump();
    expect(/class="[^"]*EditText[^"]*"/.test(xml), '同步页不该有手动输入框').toBe(false);
  }, 300_000);
});
