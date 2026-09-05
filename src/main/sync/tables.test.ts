/**
 * 同步表清单里真正会咬人的那部分：哪些列不接受对端的值。
 *
 * deviceLocal 是一句声明，改错了不会报错、不会崩，只会在两台设备之间悄悄发生
 * 数据覆盖——等用户发现时已经丢字了。所以这几条单独钉住。
 */
import { describe, expect, it } from 'vitest';
import { isDeviceLocalColumn, syncTableSpec, syncTableSpecs } from './tables';

describe('deviceLocal 列', () => {
  it('考我的作答草稿不接受对端值', () => {
    // 还没提交的半截答案是「这台设备上正在敲的东西」。同步过去的话，两台设备
    // 各有一份半成品，后写的那份会覆盖另一份——用户看到的是自己打的字被吞了。
    expect(isDeviceLocalColumn('knowledge_node', 'quiz_answer_draft_md')).toBe(true);
  });

  it('题目和推荐答案照常同步——它们是生成结果，不是正在编辑的内容', () => {
    expect(isDeviceLocalColumn('knowledge_node', 'quiz_question_md')).toBe(false);
    expect(isDeviceLocalColumn('knowledge_node', 'quiz_recommended_answer_md')).toBe(false);
  });

  it('考点本身的字段一个都不能被当成本机专属', () => {
    for (const column of ['name', 'mastery', 'status', 'priority_score', 'parent_id']) {
      expect(isDeviceLocalColumn('knowledge_node', column)).toBe(false);
    }
  });

  it('克隆路径仍然是本机的', () => {
    expect(isDeviceLocalColumn('repo', 'local_path')).toBe(true);
    expect(isDeviceLocalColumn('repo', 'status')).toBe(false);
  });
});

describe('表规格自检', () => {
  it('deviceLocal 只能引用真实存在的列', () => {
    // buildSpec 会对不存在的列抛错，这里跑一遍全表确认清单没有写错的列名
    expect(() => syncTableSpecs()).not.toThrow();
  });

  it('新加的草稿列在 knowledge_node 的列清单里', () => {
    expect(syncTableSpec('knowledge_node').columns).toContain('quiz_answer_draft_md');
  });

  it('插件运行时表全部同步，且父表顺序先于引用方', () => {
    const names = syncTableSpecs().map((spec) => spec.name);
    for (const table of [
      'role_profile',
      'campaign_plugin_binding',
      'campaign_runtime_descriptor',
      'migration_checkpoint',
    ]) {
      expect(names).toContain(table);
    }
    expect(names.indexOf('role_profile')).toBeLessThan(names.indexOf('campaign'));
    expect(names.indexOf('campaign')).toBeLessThan(names.indexOf('campaign_plugin_binding'));
    expect(names.indexOf('campaign')).toBeLessThan(
      names.indexOf('campaign_runtime_descriptor'),
    );
    expect(names.indexOf('campaign')).toBeLessThan(names.indexOf('migration_checkpoint'));
    expect(syncTableSpec('campaign').columns).toContain('role_profile_id');
  });

  it('不在清单里的表要报错，别让调用方以为它在同步', () => {
    expect(() => syncTableSpec('search_cache')).toThrow('不在同步清单里');
  });
});
