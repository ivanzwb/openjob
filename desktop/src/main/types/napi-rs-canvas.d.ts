/**
 * @napi-rs/canvas 的类型补充声明。
 *
 * 背景：pdf-parse → pdfjs-dist 的 legacy 构建（pdf.mjs）在模块顶层执行
 * `new DOMMatrix()`（pdf.mjs:15620 SCALE_MATRIX），Node/Electron 主进程
 * 没有 DOM API。官方 polyfill 依赖 @napi-rs/canvas 的原生绑定，但打包后
 * 原生绑定缺失时 polyfill 落空，导致 "ReferenceError: DOMMatrix is not defined"。
 *
 * resumeImport.ts 的 ensureDOMMatrix() 会在加载 pdf-parse 前把全局 DOMMatrix
 * 装上（优先 @napi-rs/canvas 原生实现，退回 @napi-rs/canvas/geometry 纯 JS 实现）。
 * 本文件只为这两条加载路径补类型：
 *  1. `@napi-rs/canvas/geometry` 没有 geometry.d.ts（包内 files 只有 geometry.js），
 *     bundler 解析下需要 ambient 声明给出具名导出；
 *  2. lib 只有 ES2023、@types/node 不声明 DOMMatrix（grep 24/25/26 均无），
 *     全局 DOMMatrix 需要补类型供 ensureDOMMatrix 赋值使用。
 */
// @napi-rs/canvas 无 exports 字段，Node ESM 要求带 .js 后缀才能解析子路径
declare module '@napi-rs/canvas/geometry.js' {
  export const DOMPoint: typeof import('@napi-rs/canvas').DOMPoint;
  export const DOMMatrix: typeof import('@napi-rs/canvas').DOMMatrix;
  export const DOMRect: typeof import('@napi-rs/canvas').DOMRect;
}

// 全局 DOMMatrix：lib=ES2023 无 DOM、@types/node 不声明，这里补上
// （运行时由 resumeImport.ts 的 ensureDOMMatrix() 注入，仅类型声明）。
declare var DOMMatrix: typeof import('@napi-rs/canvas').DOMMatrix;