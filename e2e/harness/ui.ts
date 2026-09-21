/**
 * 界面层助手。
 *
 * 应用把所有页签都留在 DOM 里、只用 `hidden` 隐藏（TabPanel），所以任何查询都必须限定在
 * **当前激活的面板**里——否则会命中别的页签里的同名元素（比如话术库的列表项）。
 */
import type { AppInstance } from './app';

/**
 * 当前激活的面板。
 *
 * 多数页签包在 TabPanel 里（只对非激活页加 hidden），备考页是自己管 active 的（外面没有
 * TabPanel），所以没有 TabPanel 时退到 `main`——那样就必须按可见性过滤，否则会命中
 * 藏在 `hidden` 里的别的页签。
 */
export const ACTIVE = `(document.querySelector('main > div:not(.hidden)') ?? document.querySelector('main'))`;

/** 在当前面板里按可见性挑元素：高度为 0 的一律不算 */
export const VISIBLE = (selector: string): string =>
  `[...(${ACTIVE}.querySelectorAll(${JSON.stringify(selector)}) ?? [])].filter((n) => n.getBoundingClientRect().height > 0)`;

export async function clickNav(app: AppInstance, label: string): Promise<void> {
  const ok = await app.page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('header nav button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!ok) throw new Error(`找不到导航项：${label}`);
  await app.page.waitFor(`${ACTIVE} && ${ACTIVE}.offsetHeight > 0`, { label: `${label} 面板出现` });
}

export async function navLabels(app: AppInstance): Promise<string[]> {
  return app.page.evaluate<string[]>(
    `[...document.querySelectorAll('header nav button')].map((b) => b.textContent.trim())`,
  );
}

/** 在当前激活面板里按文本命中按钮；返回命中的按钮文字 */
export async function clickButton(app: AppInstance, pattern: string): Promise<string> {
  const result = await app.page.evaluate<{ ok: boolean; text?: string; buttons?: string[] }>(
    `(() => {
       const panel = ${ACTIVE};
       const all = [...(panel?.querySelectorAll('button') ?? [])];
       const hit = all.find((b) => new RegExp(${JSON.stringify(pattern)}).test(b.textContent) && !b.disabled);
       if (!hit) return { ok: false, buttons: all.map((b) => b.textContent.trim().slice(0, 18) + (b.disabled ? '(禁用)' : '')) };
       hit.click();
       return { ok: true, text: hit.textContent.trim() };
     })()`,
  );
  if (!result.ok) throw new Error(`按钮点不动：${pattern}；当前按钮 = ${result.buttons?.join(' , ')}`);
  return result.text ?? '';
}

/** 按钮是否存在且禁用——用于断言「缺前置条件时不让点」 */
export async function buttonState(
  app: AppInstance,
  pattern: string,
): Promise<{ found: boolean; disabled: boolean }> {
  return app.page.evaluate<{ found: boolean; disabled: boolean }>(`(() => {
    const panel = ${ACTIVE};
    const hit = [...(panel?.querySelectorAll('button') ?? [])]
      .find((b) => new RegExp(${JSON.stringify(pattern)}).test(b.textContent));
    return hit ? { found: true, disabled: hit.disabled } : { found: false, disabled: false };
  })()`);
}

export async function activeText(app: AppInstance): Promise<string> {
  return app.page.evaluate<string>(
    `(${ACTIVE}?.innerText ?? '').replace(/\\s+/g, ' ').trim()`,
  );
}

export async function waitActiveText(
  app: AppInstance,
  pattern: string,
  label: string,
  timeout = 120_000,
): Promise<string> {
  return app.page.waitUntil(
    async () => {
      const text = await activeText(app);
      return new RegExp(pattern).test(text) ? text : '';
    },
    label,
    timeout,
  );
}

/** 练习页的报错行（error 是 text-red-400 的 p） */
export async function errorText(app: AppInstance): Promise<string> {
  return app.page.evaluate<string>(`(() => {
    const panel = ${ACTIVE};
    const hit = [...(panel?.querySelectorAll('p') ?? [])].find((p) => p.className.includes('text-red-400'));
    return hit ? hit.textContent.trim() : '';
  })()`);
}

export async function selectValue(app: AppInstance, labelText: string, value: string): Promise<void> {
  const ok = await app.page.evaluate<boolean>(`(() => {
    const panel = ${ACTIVE};
    const select = [...(panel?.querySelectorAll('select') ?? [])]
      .find((s) => s.closest('label')?.textContent.includes(${JSON.stringify(labelText)}));
    if (!select) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`找不到下拉：${labelText}`);
}

export async function selectOptions(app: AppInstance, labelText: string): Promise<string[] | null> {
  return app.page.evaluate<string[] | null>(`(() => {
    const panel = ${ACTIVE};
    const select = [...(panel?.querySelectorAll('select') ?? [])]
      .find((s) => s.closest('label')?.textContent.includes(${JSON.stringify(labelText)}));
    return select ? [...select.options].map((o) => o.value) : null;
  })()`);
}

export async function fillAnswer(app: AppInstance, text: string): Promise<void> {
  await app.page.evaluate(`(() => {
    const textarea = ${ACTIVE}.querySelector('textarea');
    if (!textarea) throw new Error('当前面板没有作答框');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

/** 工具行（题型 / 面试语言 / 开始练习 那一排）的几何信息 */
export async function toolbarGeometry(app: AppInstance): Promise<Array<{
  text: string;
  top: number;
  bottom: number;
  left: number;
  width: number;
}>> {
  return app.page.evaluate(`(() => {
    const panel = ${ACTIVE};
    const row = [...panel.querySelectorAll('div')].find(
      (d) => d.className.includes('flex-wrap') && d.querySelector('select') && d.querySelector('button'),
    );
    if (!row) throw new Error('没找到工具行');
    return [...row.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        text: (child.querySelector('span')?.textContent ?? child.textContent).trim().slice(0, 10),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
      };
    });
  })()`);
}

/** 一段带换行的真实自我介绍作答，评分用例拿它当引文来源 */
export const ANSWER_MD =
  '我是赵伟炳，做软件研发 17 年，其中 15 年在诺基亚做设备管理平台的软件架构师。' +
  '我主导过 Web 基站网元管理系统从 C/S 到 B/S 的架构演进，抽象出统一后端接口。' +
  '贵司岗位要求的架构设计与性能优化，正是我在 WebEM 与 PDL 参数校验系统里积累的。';
