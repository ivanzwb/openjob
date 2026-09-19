/**
 * 移动端 WebView 运行时（§12.5 同构桥）。
 *
 * 插件入口在 WebView 的 JS 环境里激活：shim 页面提供 `require('openjob')` 门面
 * （postMessage → RN onMessage → invokeRemote → 桌面白名单通道），收集
 * `ctx.views.registerPage` 的页面并渲染 Webview 资产。入口与 ui/ 资产是岗位包的
 * mobile/ 那份（前缀已剥），与桌面那份同构——差别只在桥的传输实现与本机能力判定。
 */

export interface MobilePluginRuntime {
  pluginId: string;
  version: string;
  displayName: string;
  permissions: string[];
  uiAssets: Record<string, string>;
  mainSource: string;
}

/** RN → WebView 的回复注入：经 injectJavaScript 调 shim 的全局回信函数 */
export function replyScript(reqId: number, result: unknown, error: string | null): string {
  const payload = JSON.stringify({ reqId, result, error });
  return `window.__openjobReply(${payload}); true;`;
}

/**
 * 构造 WebView 运行时页面的 HTML。
 *
 * 结构：openjob 门面（postMessage 桥）→ CommonJS 装配 main.js → 收集注册的
 * 页面 → 渲染第一个页面（iframe srcDoc 内嵌 ui 资产，二层桥直通 RN）。
 */
export function buildMobileRuntimeHtml(plugin: MobilePluginRuntime): string {
  const mainSource = JSON.stringify(plugin.mainSource);
  const uiAssets = JSON.stringify(plugin.uiAssets);
  const pluginId = JSON.stringify(plugin.pluginId);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { margin: 0; padding: 12px; font-family: system-ui, sans-serif; }
  iframe { border: 0; width: 100%; height: 100vh; }
</style>
</head>
<body>
<div id="openjob-pages"></div>
<script>
(function () {
  'use strict';
  var pluginId = ${pluginId};
  var uiAssets = ${uiAssets};
  var mainSource = ${mainSource};
  var reqSeq = 0;
  var pending = {};
  var pages = [];
  var commands = {};
  var bridgeMethods = [];

  function postToRn(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function callHost(method, params) {
    return new Promise(function (resolve, reject) {
      var reqId = ++reqSeq;
      pending[reqId] = { resolve: resolve, reject: reject };
      postToRn({ openjob: { reqId: reqId, method: method, params: params || {} } });
    });
  }

  window.__openjobReply = function (reply) {
    var entry = pending[reply.reqId];
    if (!entry) return;
    delete pending[reply.reqId];
    if (reply.error) entry.reject(new Error(reply.error));
    else entry.resolve(reply.result);
  };

  document.addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.__openjobReply) window.__openjobReply(data.__openjobReply);
  });

  var openjob = {
    pluginId: pluginId,
    campaign: { getDescriptor: function (campaignId) { return callHost('campaign.getDescriptor', { campaignId: campaignId }); } },
    storage: {
      get: function (key) { return callHost('storage.get', { key: key }); },
      set: function (key, value) { return callHost('storage.set', { key: key, value: value }); },
      delete: function (key) { return callHost('storage.delete', { key: key }); }
    },
    // 包声明的数据集合：手机端只读，只暴露读侧（写侧由 RN 侧原语表如实拒绝）
    data: {
      get: function (collection, key) { return callHost('data.get', { collection: collection, key: key }); },
      list: function (collection, options) {
        options = options || {};
        return callHost('data.list', { collection: collection, prefix: options.prefix, limit: options.limit });
      },
      count: function (collection) { return callHost('data.count', { collection: collection }); }
    },
    views: {
      registerPage: function (page) {
        pages.push({
          id: pluginId + ':' + page.id,
          title: page.title,
          webviewPath: page.webviewPath
        });
        return { dispose: function () {} };
      }
    },
    commands: {
      register: function (id, handler) {
        commands[pluginId + ':' + id] = handler;
        return { dispose: function () {} };
      }
    },
    events: {
      // §7：手机端是 view-only，没有宿主事件流；订阅进来只登记、不投递（不假装能收到）
      on: function () { return { dispose: function () {} }; }
    },
    bridge: {
      // 桥自注册（§11.2）：登记本包要用的桥方法名，随 openjobDeclarations 回传 RN，
      // 宿主按声明放行；未声明的方法一律拒（远端网关仍逐次校验权限）
      declare: function (name) {
        if (bridgeMethods.indexOf(name) < 0) bridgeMethods.push(name);
        return { dispose: function () {} };
      },
      methods: function () { return bridgeMethods.slice(); }
    }
  };

  var module = { exports: {} };
  var requireShim = function (id) {
    if (id === 'openjob') return openjob;
    throw new Error('插件只允许 require("openjob")，实际请求了 ' + id);
  };
  new Function('module', 'exports', 'require', mainSource)(module, module.exports, requireShim);

  // 激活入口：与桌面同构（宿主调用 activate(ctx)）。抛错不吞，回传 RN 让界面显式报错
  try {
    if (module.exports && typeof module.exports.activate === 'function') {
      module.exports.activate(openjob);
    }
  } catch (error) {
    postToRn({ openjobActivationError: String((error && error.message) || error) });
  }
  // 包声明的桥方法回传 RN：宿主据此放行（声明 !== 权限，远端网关仍逐次校验）
  postToRn({ openjobDeclarations: bridgeMethods.slice() });

  // 相对引用解析：与桌面共用同一规则（core pluginRuntime/assets 的 JS 等价实现）
  function isRelative(ref) {
    return !/^(https?:|data:|\/\/)/i.test(ref);
  }
  function resolvePath(entryPath, ref) {
    if (!isRelative(ref)) return null;
    var dir = entryPath.indexOf('/') >= 0 ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : '';
    var parts = (dir + ref).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (out.length === 0) return null;
        out.pop();
        continue;
      }
      out.push(part);
    }
    return out.join('/');
  }
  function resolveWebviewHtml(entryPath, html) {
    var result = html.replace(/<script([^>]*?)src\s*=\s*("([^"]*)"|'([^']*)')([^>]*)>\s*<\/script>/gi,
      function (match, before, raw, q1, q2) {
        var ref = (q1 || q2 || '').trim();
        if (!ref || !isRelative(ref)) return match;
        var path = resolvePath(entryPath, ref);
        if (path === null || uiAssets[path] === undefined) return match;
        return '<script' + before + '>' + uiAssets[path] + '</script>';
      });
    result = result.replace(/<link([^>]*?)href\s*=\s*("([^"]*)"|'([^']*)')([^>]*)>/gi,
      function (match, before, raw, q1, q2) {
        if (!/rel\s*=\s*["']stylesheet["']/i.test(before)) return match;
        var ref = (q1 || q2 || '').trim();
        if (!ref || !isRelative(ref)) return match;
        var path = resolvePath(entryPath, ref);
        if (path === null || uiAssets[path] === undefined) return match;
        return '<style>' + uiAssets[path] + '</style>';
      });
    return result;
  }

  function renderPage(page) {
    var host = document.getElementById('openjob-pages');
    host.innerHTML = '';
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.border = '0';
    frame.style.width = '100%';
    frame.style.height = '100vh';
    host.appendChild(frame);
    var html = uiAssets[page.webviewPath] || '<p>缺少资源</p>';
    frame.srcdoc = resolveWebviewHtml(page.webviewPath, html);
  }

  function renderFirst() {
    if (pages.length > 0) renderPage(pages[0]);
    else postToRn({ openjobNoPages: true });
  }

  // ui 资产的二层桥：iframe 内 postMessage → 这里转发给 RN
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.openjob) {
      callHost(data.openjob.method, data.openjob.params).then(function (result) {
        if (event.source) event.source.postMessage({ openjobResponse: { reqId: data.openjob.reqId, result: result, error: null } }, '*');
      }).catch(function (err) {
        if (event.source) event.source.postMessage({ openjobResponse: { reqId: data.openjob.reqId, result: null, error: String(err) } }, '*');
      });
    }
  });

  setTimeout(renderFirst, 0);
})();
</script>
</body>
</html>`;
}
