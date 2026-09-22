/**
 * 手机端的驱动：纯 adb，不依赖 Maestro/Detox。
 *
 * 为什么是 adb：这台机器上已经有 Android SDK（`emulator` + `adb` + system-image）和现成的
 * AVD，而 RN 的调试构建要连着 Metro 才能跑——release 包自带 JS bundle，装上去就能用。
 * 驱动只需要三件事：抓界面树（`uiautomator dump`）→ 从 XML 里读文本与坐标 → 点。
 *
 * 三个踩过的坑：
 * 1. **必须 `-gpu swiftshader_indirect`（配 `-no-window`）**：默认 GPU 模式下模拟器冷启动
 *    还没进桌面，SystemUI 自己就 ANR 了，App 永远上不了前台；
 * 2. `uiautomator dump` 在界面切换的瞬间会 `Timeout while connecting UiAutomation`——重试即可；
 * 3. dump 出来的文件要 `adb pull` 回来读，`adb shell cat` 会 permission denied。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_DIR, sleep } from '../harness/app';

const SDK = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'] ??
  join(process.env['LOCALAPPDATA'] ?? '', 'Android', 'Sdk');
export const ADB = join(SDK, 'platform-tools', 'adb.exe');
const EMULATOR = join(SDK, 'emulator', 'emulator.exe');

export const MOBILE_PACKAGE = 'com.openjob.mobile';
/**
 * 用哪个 APK。默认取 `mobile/dist` 下那份历史产物（release，自带 JS bundle，不需要 Metro）；
 * 想试刚打出来的包就把它指过去——例如 `gradlew assembleRelease` 的产出：
 * `E2E_MOBILE_APK=mobile/android/app/build/outputs/apk/release/app-release.apk`
 */
export const MOBILE_APK =
  process.env['E2E_MOBILE_APK'] ?? join(DESKTOP_DIR, '..', 'mobile', 'dist', 'OpenJob-1.0.0.apk');

export function mobileAvailable(): boolean {
  return existsSync(ADB) && existsSync(EMULATOR) && existsSync(MOBILE_APK);
}

function adb(...args: string[]): string {
  // stderr 一律吞掉：adb pull 每次都往 stderr 打一行 "1 file pulled…"，
  // 一次用例会抓几十次界面树，不吞掉整个输出就没法看了
  return execFileSync(ADB, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** 同步小睡：重试路径是同步的，用不着把它整个改成 async */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function deviceReady(): boolean {
  try {
    return adb('devices').split('\n').some((line) => line.endsWith('\tdevice'));
  } catch {
    return false;
  }
}

export class MobileDevice {
  private constructor() {}

  /** 起一个无头模拟器并等到开机完成；已经在跑就复用 */
  static async boot(avd = 'Medium_Phone_API_36.1'): Promise<MobileDevice> {
    if (!deviceReady()) {
      // `-gpu swiftshader_indirect` + `-no-window` 是必须的：默认 GPU 模式下 SystemUI
      // 冷启动就会 ANR，App 永远上不了前台（见文件头）
      execFileSync(
        'cmd',
        [
          '/c',
          'start',
          '',
          EMULATOR,
          '-avd',
          avd,
          '-gpu',
          'swiftshader_indirect',
          '-no-window',
          '-no-boot-anim',
          '-no-audio',
        ],
        { stdio: 'ignore', windowsHide: true },
      );
    }
    await MobileDevice.waitForBoot();
    return new MobileDevice();
  }

  private static async waitForBoot(timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (adb('shell', 'getprop', 'sys.boot_completed').includes('1')) return;
      } catch {
        // 还没起来
      }
      if (Date.now() > deadline) throw new Error('模拟器启动超时');
      await sleep(5_000);
    }
  }

  /** 装（或覆盖装）包；已经装着同版本时也会很快 */
  install(apk = MOBILE_APK): void {
    adb('install', '-r', apk);
  }

  /** 冷启动一次应用，并等过「正在初始化本地数据库…」那一步 */
  async launch(packageName = MOBILE_PACKAGE): Promise<void> {
    adb('shell', 'am', 'force-stop', packageName);
    await sleep(500);
    adb('shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1');
    // 首次启动要跑 SQLite 迁移（logcat 里能看到密集的 major fault），给它时间
    await sleep(20_000);
  }

  /** 当前界面上的文本（按出现顺序） */
  texts(): string[] {
    const xml = this.dump();
    return [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]!).filter((t) => t !== '');
  }

  /** 界面树原文：要断言「没有写入口」这类否定命题时得看完整的节点集合 */
  dump(attempt = 0): string {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml');
    } catch (error) {
      // dump 在界面切换瞬间会连不上 UiAutomation，重试几次就好
      if (attempt >= 3) throw error;
      sleepSync(1_500);
      return this.dump(attempt + 1);
    }
    const target = join(mkdtempSync(join(tmpdir(), 'cc-android-')), 'window_dump.xml');
    adb('pull', '/sdcard/window_dump.xml', target);
    return readFileSync(target, 'utf8');
  }

  /** 按文本点一个节点（取它的 bounds 中心） */
  tapText(text: string): boolean {
    const xml = this.dump();
    const node = [...xml.matchAll(/<node[^>]*>/g)]
      .map((m) => m[0])
      .find((tag) => tag.includes(`text="${text}"`));
    const bounds = node ? /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node) : null;
    if (!bounds) return false;
    const x = Math.round((Number(bounds[1]) + Number(bounds[3])) / 2);
    const y = Math.round((Number(bounds[2]) + Number(bounds[4])) / 2);
    adb('shell', 'input', 'tap', String(x), String(y));
    return true;
  }

  /** 等某段文本出现；返回命中时的全部文本 */
  async waitForText(text: string, timeoutMs = 60_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = this.texts();
      if (current.some((item) => item.includes(text))) return current;
      if (Date.now() > deadline) {
        throw new Error(`等不到「${text}」；当前界面 = ${current.slice(0, 20).join(' | ')}`);
      }
      await sleep(1_000);
    }
  }

  shutdown(): void {
    try {
      adb('emu', 'kill');
    } catch {
      // 已经关了
    }
  }
}
