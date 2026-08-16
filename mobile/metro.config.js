const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  '@shared': path.resolve(workspaceRoot, 'src/shared'),
  // whisper.rn 依赖 safe-buffer → require('buffer')（Node 内置）。
  // Metro 默认不解析 Node 内置模块，用 npm 的 buffer 包顶替。
  buffer: require.resolve('buffer/'),
};

module.exports = config;
