/**
 * 宿主界面的纯逻辑。
 *
 * 渲染进程没有组件测试环境，能力门控、证据分组、练习状态归约这类判断留在 tsx 里就等于
 * 没有覆盖。放在这里既能被现有 vitest 套件直接测到，也让「界面只消费 descriptor」这条
 * 约束有一个可检查的落点。
 */

export * from './capabilityNav';
export * from './evidenceReview';
export * from './navigation';
export * from './practiceState';
export * from './rolePlugins';
