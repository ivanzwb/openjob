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

// Workaround: RN Android 的 okhttp 4.12 解析大体积 multipart+chunked dev bundle
// 时确定性失败（ProtocolException: Expected leading [0-9a-fA-F] ...），
// 见 https://github.com/expo/expo/issues/49111。客户端固定请求
// `Accept: multipart/mixed`，这里对 bundle 请求剥掉该头，让 Metro 回退为普通
// application/javascript + Content-Length 响应，RN 走非 multipart 下载路径。
// 上游修好（okhttp/RN 升级）后可移除。
const originalEnhanceMiddleware = config.server && config.server.enhanceMiddleware;
config.server = config.server || {};
config.server.enhanceMiddleware = (metroMiddleware, server) => {
  const enhanced =
    typeof originalEnhanceMiddleware === 'function'
      ? originalEnhanceMiddleware(metroMiddleware, server)
      : metroMiddleware;
  return (req, res, next) => {
    const url = req.url || '';
    if ((url.includes('.bundle') || url.includes('virtual-metro-entry')) && req.headers && req.headers.accept) {
      req.headers.accept = 'application/javascript';
    }
    return enhanced(req, res, next);
  };
};

module.exports = config;
