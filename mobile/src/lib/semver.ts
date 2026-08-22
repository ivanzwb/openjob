/**
 * 发布 tag 与安装版本号的比较。
 *
 * 实现搬到了 `@shared/version`：端间同步的版本闸门要求桌面端用同一套比较规则，
 * 而两端各留一份「差不多」的实现，迟早会出现一端判相同、另一端判不同的情况。
 * 这里只做转发，保留原来的导入路径。
 */
export { compareVersions, normalizeVersion } from '@shared/version';
