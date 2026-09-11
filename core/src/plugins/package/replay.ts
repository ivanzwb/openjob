/**
 * 把包里录下来的 contributions 变回一个 CapabilityPlugin。
 *
 * 这是包格式的逆运算。之所以能这么简单，是因为 CapabilityRegistry 的三个注册方法接受
 * 的全是纯数据：register() 唯一的作用就是把这些声明推给 registry，那么把推的动作重放
 * 一遍，与执行插件自己的 register() 完全等价，且不需要执行任何外部代码。
 */
import type { CapabilityPlugin, PluginManifest } from '../types';
import type { PluginPackageContributions } from './contract';

/**
 * 反向操作：录一遍 register() 推给 registry 的东西，得到可随包发布的 contributions。
 *
 * 打包侧（scripts/pack-plugins.mjs）用它把内置能力插件的声明录出来。与 toCapabilityPlugin
 * 放在同一个文件，是因为两者必须严格互逆——分开放，改了一个忘了另一个不会有任何提示。
 */
export function recordContributions(plugin: CapabilityPlugin): PluginPackageContributions {
  const contributions: Required<PluginPackageContributions> = {
    tools: [],
    artifactParsers: [],
    interactions: [],
  };
  plugin.register({
    registerTool: (tool) => contributions.tools.push(tool),
    registerArtifactParser: (parser) => contributions.artifactParsers.push(parser),
    registerInteractionType: (interaction) => contributions.interactions.push(interaction),
  });
  return contributions;
}

export function toCapabilityPlugin(
  manifest: PluginManifest,
  contributions: PluginPackageContributions,
): CapabilityPlugin {
  return {
    manifest,
    register(registry) {
      // 顺序按 tools → parsers → interactions 固定，别依赖对象键序：
      // 注册顺序会影响重复注册时的报错文案，而那段文案进了 golden 判据
      for (const tool of contributions.tools ?? []) registry.registerTool(tool);
      for (const parser of contributions.artifactParsers ?? []) {
        registry.registerArtifactParser(parser);
      }
      for (const interaction of contributions.interactions ?? []) {
        registry.registerInteractionType(interaction);
      }
    },
  };
}
