/**
 * 随 release 单独分发的岗位包，**不进基础包**。
 *
 * 这个数组只有两类消费者：`scripts/pack-plugins.mjs`（打成签名包）和测试（校验包内容）。
 * 应用自己一行都不许引用——引用了就等于岗位包又被编译进基础包，而这次退化没有任何报错，
 * 表现是「基础包里莫名带着三个岗位」。`basePackage.test.ts` 静态扫描盯住这条线。
 *
 * 与之对应，运行时的岗位包一律来自 `userData/plugins` 的安装清单，见
 * `src/main/plugins/runtime.ts` 的 `findInstalledRolePack`。
 */
import type { RolePack } from '@core/plugins/types';
import { productManagerRolePack } from './productManager';
import { salesCustomerSuccessRolePack } from './salesCustomerSuccess';
import { softwareEngineeringRolePack } from './softwareEngineering';

export const DISTRIBUTED_ROLE_PACKS: readonly RolePack[] = [
  softwareEngineeringRolePack,
  productManagerRolePack,
  salesCustomerSuccessRolePack,
];
