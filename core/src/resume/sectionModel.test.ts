/**
 * 教育经历「专业 · 学历」role 拆分/合并的单元测试。
 *
 * 表单拆成「专业」「学历」两个输入框，落库仍合并进 role（`### 学校 | 专业 · 学历 | 时间`）。
 * 这里保证拆分不会吃掉历史数据：只有专业、只有学历、无分隔符都能正确拆开。
 */
import { describe, expect, it } from 'vitest';
import { joinEducationRole, splitEducationRole } from './sectionModel';

describe('splitEducationRole', () => {
  it('「专业 · 学历」拆成专业与学历', () => {
    expect(splitEducationRole('计算机科学与技术 · 本科')).toEqual({
      major: '计算机科学与技术',
      degree: '本科',
    });
  });

  it('历史数据只有专业（无学历）时整串当专业', () => {
    expect(splitEducationRole('计算机科学与技术')).toEqual({
      major: '计算机科学与技术',
      degree: '',
    });
  });

  it('历史数据只有学历（无专业）时整串当学历', () => {
    expect(splitEducationRole('本科')).toEqual({ major: '', degree: '本科' });
  });

  it('无空格分隔的「专业·本科」也能拆开', () => {
    expect(splitEducationRole('软件工程·本科')).toEqual({
      major: '软件工程',
      degree: '本科',
    });
  });

  it('认全常见学历词', () => {
    expect(splitEducationRole('法学 · 硕士')).toEqual({ major: '法学', degree: '硕士' });
    expect(splitEducationRole('临床医学 · 博士')).toEqual({ major: '临床医学', degree: '博士' });
    expect(splitEducationRole('机械制造 · 大专')).toEqual({ major: '机械制造', degree: '大专' });
    expect(splitEducationRole('工商管理 · MBA')).toEqual({ major: '工商管理', degree: 'MBA' });
  });

  it('空串返回空专业空学历', () => {
    expect(splitEducationRole('')).toEqual({ major: '', degree: '' });
    expect(splitEducationRole('   ')).toEqual({ major: '', degree: '' });
  });

  it('「专业 · 学历」拆分后合并能还原', () => {
    const { major, degree } = splitEducationRole('电子信息工程 · 本科');
    expect(joinEducationRole(major, degree)).toBe('电子信息工程 · 本科');
  });
});

describe('joinEducationRole', () => {
  it('专业与学历都填时用「 · 」连接', () => {
    expect(joinEducationRole('计算机科学与技术', '本科')).toBe('计算机科学与技术 · 本科');
  });

  it('只填专业时不带学历', () => {
    expect(joinEducationRole('计算机科学与技术', '')).toBe('计算机科学与技术');
  });

  it('只填学历时只有学历', () => {
    expect(joinEducationRole('', '本科')).toBe('本科');
  });

  it('全空时输出空串', () => {
    expect(joinEducationRole('', '')).toBe('');
  });

  it('两侧多余空白被修剪', () => {
    expect(joinEducationRole(' 计算机科学与技术 ', ' 本科 ')).toBe('计算机科学与技术 · 本科');
  });
});