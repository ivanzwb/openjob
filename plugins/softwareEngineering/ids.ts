/**
 * 岗位包与历史数据共用同一组 id：本包已经被 pin 进插件化之前的旧 Campaign 的
 * descriptor 与 quiz/design 投影，两处各写一份迟早会分叉，而分叉的表现是旧记录
 * 换了套量规。因此 id 保持历史字面量 'software-engineering'，包内容换代只走版本号。
 */
export const SOFTWARE_ENGINEERING_ROLE_PACK_ID = 'software-engineering';

/**
 * 岗位包自身的版本与旧数据无关了：版本号只描述包内容，id 仍沿用历史字面量
 * 'software-engineering'（旧 Campaign 的 descriptor 与题型投影 pin 着它），
 * 包内容换代时版本要跟着走，否则解析器会把新旧两份包当成同一份。
 */
export const SOFTWARE_ENGINEERING_ROLE_PACK_VERSION = '1.0.0';

/**
 * 本包内嵌的源码能力 id。
 *
 * 能力不是独立的包：这条 id 就是声明自己的名字，同时被题型（readCode 任务）与宿主实现
 * （`desktop/src/main/repo/`）按名字引用——宿主按能力 id 绑定实现，不引包。
 */
export const SOURCE_REPOSITORY_CAPABILITY_ID = 'source-repository';