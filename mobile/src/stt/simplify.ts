import { Converter } from 'opencc-js/t2cn';

/**
 * 繁→简转换器。
 *
 * whisper 多语言中文模型训练语料里繁体占比高，输出天然偏繁体；
 * 且 language: 'zh' 不区分繁简，没有任何参数能纠正这一点。
 * opencc-js 是纯 JS 实现（无原生依赖），t2cn 入口只带繁体→简体字典，
 * 用标准繁体作输入（from: 't'），避免把「软件」「数据库」这类大陆词
 * 误转成「軟體」「資料庫」式的地区词汇（那是 tw/hk 方言转换的活）。
 */
const converter = Converter({ from: 't', to: 'cn' });

/** 繁体字串转简体。纯字符级映射，不改动用词 */
export function toSimplified(text: string): string {
  return converter(text);
}