/**
 * 代码插件的**桥自注册**机制（分发计划 §11.2 / §6 判据三）。
 *
 * 现状的毛病：渲染层的桥方法表把某个岗位簇的方法写死，基础包于是躺着一张
 * 「某个岗位的方法表」。这条机制把「有哪些桥方法」改成由**包自己声明**：
 *
 * 1. 包在自己的入口代码里声明它要用的桥方法（命名空间 + 方法名）；
 * 2. 宿主按声明放行——**未声明的方法一律拒**（默认拒绝），页面够不到；
 * 3. 声明只决定「这个方法能不能到网关」。真正放行与否仍要过宿主的权限网关：
 *    每个桥原语声明自己需要的权限，网关按已安装清单判「这个包有没有资格」；
 * 4. 各端只登记本端有的原语：包声明了、但本端没有的能力**如实拒绝**
 *    （§7：手机会员端一律 view-only），不假装能用。
 *
 * 这一层是纯逻辑，不碰 Electron / Node / IPC：端侧原语表与网关都由各端注入
 * （桌面渲染层走 IPC，移动端走 WebView 桥）。不 import `plugins/package/(contract|replay)`，
 * 也没有代码执行入口。
 */
import type { PluginPermission } from '../permissions';

/**
 * 桥方法名：`<命名空间>.<方法名>`。命名空间小写（可含 `-`），方法名以字母开头。
 * 命名空间由包自己起（如 `demo.echo`），宿主不假设任何岗位簇前缀。
 */
export const PLUGIN_BRIDGE_METHOD_RE = /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*$/;

export function isPluginBridgeMethod(name: unknown): name is string {
  return typeof name === 'string' && PLUGIN_BRIDGE_METHOD_RE.test(name);
}

/** 声明的名字不合法就抛错——在入口里就拦下，别等到页面调用。 */
export function assertPluginBridgeMethod(name: unknown): asserts name is string {
  if (!isPluginBridgeMethod(name)) {
    throw new Error(`桥方法名必须是「命名空间.方法名」（如 demo.echo），实际是：${String(name)}`);
  }
}

/**
 * 宿主在某一端上放行的桥原语：一个方法名 + 它需要的权限 + 端侧实现。
 *
 * `invoke` 通常是一次受控 IPC；`permission` 交给网关判资格，缺省表示这条原语
 * 没有额外权限要求（人人可用）。
 */
export interface PluginBridgePrimitive {
  permission?: PluginPermission;
  invoke: (params: unknown) => Promise<unknown> | unknown;
}

/**
 * 端侧原语表：键是桥方法名。**表里没有的方法 = 这一端没有这个能力**——
 * 包声明了也不放行，如实拒绝（§7 手机端降级）。
 */
export type PluginBridgePrimitives = Readonly<Record<string, PluginBridgePrimitive>>;

/**
 * 桥调用的准入网关。声明只决定「能不能到网关」，这里决定「有没有资格」：
 * 包声明了 `evidence.listConfirmed` 但没有 `evidence:read-confirmed` 权限时，
 * 声明不会替它把权限要来。
 */
export interface PluginBridgeGate {
  authorize(request: {
    pluginId: string;
    method: string;
    permission?: PluginPermission;
  }): { allowed: true } | { allowed: false; code: string };
}

/**
 * 用一份已声明权限构造网关：声明了权限才放行；无权限要求的原语直接放行。
 *
 * 这是**端侧镜像**：权威判定在主进程的 `authorizePlugin`（原语的 IPC 会再过一道）。
 * 放在这里是为了让「声明 ≠ 权限」在端侧就能被如实拒掉，而不是等一次注定失败的 IPC。
 */
export function declaredPermissionBridgeGate(
  permissions: readonly string[],
): PluginBridgeGate {
  const declared = new Set(permissions);
  return {
    authorize({ permission }) {
      if (permission === undefined || declared.has(permission)) return { allowed: true };
      return { allowed: false, code: 'permission-undeclared' };
    },
  };
}

export type PluginBridgeErrorCode =
  | 'invalid-method'
  | 'not-declared'
  | 'unavailable'
  | 'gateway-denied';

export class PluginBridgeError extends Error {
  constructor(
    readonly code: PluginBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginBridgeError';
  }
}

export interface PluginBridge {
  /** 宿主实际放行的方法名 = 声明 ∩ 本端原语表；其余调用一律拒。 */
  readonly methods: readonly string[];
  /** 包声明过的全部方法名（含本端没有的），便于诊断。 */
  readonly declared: readonly string[];
  call(method: string, params: unknown): Promise<unknown>;
}

/**
 * 把「包声明的一组桥方法」叠到「本端原语表 + 网关」上，得到这包这一端实际可用的桥。
 *
 * 三层，逐层拒绝，顺序固定：
 *   1. 名字合法性 → 2. 是否声明（默认拒绝）→ 3. 本端有没有这个原语 → 4. 网关放不放行。
 */
export function createPluginBridge(input: {
  pluginId: string;
  declared: readonly string[];
  primitives: PluginBridgePrimitives;
  gate: PluginBridgeGate;
}): PluginBridge {
  const declared = [...new Set(input.declared)].filter(isPluginBridgeMethod);
  const declaredSet = new Set(declared);
  const methods = declared
    .filter((name) => input.primitives[name] !== undefined)
    .sort();

  return {
    declared,
    methods,
    async call(method, params) {
      if (!isPluginBridgeMethod(method)) {
        throw new PluginBridgeError('invalid-method', `桥方法名不合法：${String(method)}`);
      }
      if (!declaredSet.has(method)) {
        throw new PluginBridgeError('not-declared', `未声明的桥方法：${method}`);
      }
      const primitive = input.primitives[method];
      if (!primitive) {
        throw new PluginBridgeError('unavailable', `本端没有这个桥能力：${method}`);
      }
      const decision = input.gate.authorize({
        pluginId: input.pluginId,
        method,
        permission: primitive.permission,
      });
      if (!decision.allowed) {
        throw new PluginBridgeError(
          'gateway-denied',
          `桥方法被网关拒绝：${method}（${decision.code}）`,
        );
      }
      return primitive.invoke(params);
    },
  };
}
