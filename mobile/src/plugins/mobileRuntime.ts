/**
 * 移动端 WebView 运行时（§12.5 同构桥）。
 *
 * 插件入口在 WebView 的 JS 环境里激活：shim 页面提供 `require('openjob')` 门面
 * （postMessage → RN onMessage → invokeRemote → 桌面白名单通道），收集
 * `ctx.views.registerPage` 的页面并渲染 Webview 资产。与桌面共享同一份
 * main.js 与 ui/ 资产——差别只在桥的传输实现与本机能力判定。
 */

export interface MobileCodePlugin {
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
export function buildMobileRuntimeHtml(plugin: MobileCodePlugin): string {
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
    }
  };

  var module = { exports: {} };
  var requireShim = function (id) {
    if (id === 'openjob') return openjob;
    throw new Error('插件只允许 require("openjob")，实际请求了 ' + id);
  };
  new Function('module', 'exports', 'require', mainSource)(module, module.exports, requireShim);

  function renderPage(page) {
    var host = document.getElementById('openjob-pages');
    host.innerHTML = '';
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.border = '0';
    frame.style.width = '100%';
    frame.style.height = '100vh';
    host.appendChild(frame);
    frame.srcdoc = uiAssets[page.webviewPath] || '<p>缺少资源</p>';
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
