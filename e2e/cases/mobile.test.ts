/**
 * E132 / E133 手机端（React Native）。
 *
 * 与桌面那套共用不了同一个驱动——手机端没有 CDP 可连，得走 adb：抓界面树 → 读文本与坐标 → 点。
 * 因此这两条也刻意写得**只断言屏幕上真的有/真的没有**，不去碰需要「配对过」才能造出来的状态：
 *
 * - **E132 的一半**：插件页（源码 / 话术）在没有同步过数据时应该给「先在桌面端…」这类只读
 *   引导，而**不是**出现任何写入口（发消息框、存话术按钮）——这正是「手机端是同步客户端」
 *   这条定位的界面证据；
 * - **E133**：配对过但对端不可达的降级状态需要一条真实的 peer 行，而手机端的库在应用私有
 *   目录里（release 包不可 `run-as`、模拟器也未必能给 root），所以这条仍然只覆盖「没配对时
 *   的降级」——它和 E133 要验的那条不是同一个状态，如实标成未覆盖而不是拿它充数。
 *
 * release 包是上一次构建的快照（`mobile/dist/OpenJob-1.0.0.apk`，自带 JS bundle 不需要
 * Metro）。
 *
 * **默认不跑**（`E2E_MOBILE=1` 才跑）：要起模拟器、装 126MB 的包，代价远高于其余各组，
 * 且依赖本机有 AVD。
 *
 * **要用当前源码重打的包**：`mobile/dist/OpenJob-<版本>.apk` 是发布落包的地方，但它是
 * `.gitignore` 的、本地不会有人刷新——旧包会让应用永远停在「正在初始化本地数据库…」，
 * 看着像应用起不来。测试台按新旧挑（见 `harness/mobile.ts`），也可用 `E2E_MOBILE_APK` 指定。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MobileDevice, mobileAvailable } from '../harness/mobile';

const enabled = process.env['E2E_MOBILE'] === '1';
const available = mobileAvailable();

describe.skipIf(!enabled || !available)('E132 / E133 手机端', () => {
  let device: MobileDevice;

  beforeAll(async () => {
    device = await MobileDevice.boot();
    device.install();
    await device.launch();
  }, 600_000);

  afterAll(() => {
    device?.shutdown();
  });

  it('E132a 应用能起来：过掉首次建库，主页面渲染出来', async () => {
    // 首次启动要跑 SQLite 迁移（logcat 里是密集的 major fault），给它时间
    const texts = await device.waitForText('备考', 180_000);
    expect(texts.length).toBeGreaterThan(0);
    // 起崩了会是 ErrorBoundary 或系统弹窗，这里要求看到的是应用自己的页签
    expect(texts.join(' | ')).toMatch(/备考|总览|简历|面试|更多/);
  }, 300_000);

  it('E132b 更多页：只有本机已有的入口，插件页要桌面端同步过来才出现；且没有任何写入口', async () => {
    device.tapText('更多');
    await device.waitForText('同步', 60_000);

    const dump = device.dump();
    const texts = device.texts().join(' | ');

    // 「同步」是手机端的定位：数据从桌面端来
    expect(texts).toContain('同步');
    expect(texts).toContain('话术');

    // 还没同步过岗位包，所以插件页（源码）整块不该渲染——不是给个空壳，是不出现
    expect(texts).not.toContain('源码');

    // 「没有写入口」是这条的重点：界面树里不该出现发消息、存话术、出题这类控件
    const writeControls = ['发送', '存为话术', '出题', '新建', '开始练习', '标记本页行区间'];
    for (const control of writeControls) {
      expect(dump.includes(`text="${control}"`), `不该出现写入口：${control}`).toBe(false);
    }
  }, 300_000);

  it('E132c 未配对时的状态是明确的：只给扫码入口，没有手动输入', async () => {
    device.tapText('同步');
    const sync = await device.waitForText('未配对', 60_000);
    const joined = sync.join(' | ');

    // 状态明确说清「未配对」以及该去哪儿生成二维码
    expect(joined).toContain('未配对');
    expect(joined).toMatch(/桌面端|二维码/);

    // 配对入口只有扫码：没有输入框——模拟器里扫不了码，这也是 E133 只能靠
    // 「可调试包 + 预置库」而不能靠真配对的原因（见方案 §0.2）
    const xml = device.dump();
    expect(/class="[^"]*EditText[^"]*"/.test(xml), '同步页不该有手动输入框').toBe(false);
  }, 300_000);
});
