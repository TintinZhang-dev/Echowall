// ===== 白标化 · 站点品牌配置注入（Phase A）=====
// 拉取 /api/site-config，注入品牌文案 / 主题色 / 页脚署名。
// 带 localStorage 缓存回退：接口抖动时页面不空白、文案不丢。
// 规则：
//   [data-site="school.name"]          -> textContent = 配置值（点路径）
//   [data-site="🔐 登录 {brand.logoText}"] -> 含 {path} 占位符则整段替换
//   [data-site-attr="placeholder"] + [data-site=...] -> 写到指定属性而非 textContent
//   <title data-site-title="登录|brand.logoText">  -> 前缀 + " — " + 配置值
//   brand.themeColor -> document.documentElement 的 --accent + <meta name="theme-color">
//   页脚署名：© {year} {product.name} · 由 {founder.name}（{founder.nameEn}）创建（showInFooter:false 则不渲染）
(function () {
  'use strict';

  var CACHE_KEY = 'site-config-cache-v1';

  function getPath(obj, path) {
    if (!obj || !path) return undefined;
    return String(path).split('.').reduce(function (o, k) {
      return (o && typeof o === 'object' && k in o) ? o[k] : undefined;
    }, obj);
  }

  // 含 {path} 占位符 -> 模板替换；否则 -> 整段当作点路径取值
  function render(value, cfg) {
    if (typeof value !== 'string') return '';
    if (value.indexOf('{') === -1) {
      var v = getPath(cfg, value);
      return (v === undefined || v === null) ? '' : String(v);
    }
    return value.replace(/\{([a-zA-Z0-9_.]+)\}/g, function (_, p) {
      var v = getPath(cfg, p);
      return (v === undefined || v === null) ? '' : String(v);
    });
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeCache(cfg) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  var config = readCache();

  // 供页面内联脚本同步取配置（申诉/重置/后台里的微信文案）
  window.siteGet = function (path) {
    return config ? getPath(config, path) : undefined;
  };
  window.siteRender = function (tmpl) {
    return config ? render(tmpl, config) : '';
  };

  function injectFooter(cfg) {
    if (document.getElementById('site-footer')) return;
    var product = getPath(cfg, 'product.name') || '';
    var founderName = getPath(cfg, 'founder.name');
    var founderEn = getPath(cfg, 'founder.nameEn');
    var founderLink = getPath(cfg, 'founder.link');

    var el = document.createElement('footer');
    el.id = 'site-footer';
    el.style.cssText = 'text-align:center;padding:16px 12px calc(18px + env(safe-area-inset-bottom));' +
      'font-size:0.72rem;color:#8899a6;line-height:1.7;';

    var line = document.createElement('div');
    line.appendChild(document.createTextNode('© ' + new Date().getFullYear() + ' ' + product));

    if (founderName) {
      line.appendChild(document.createTextNode(' · 由 '));
      var nameNode;
      if (founderLink) {
        nameNode = document.createElement('a');
        nameNode.href = founderLink;
        nameNode.target = '_blank';
        nameNode.rel = 'noopener noreferrer';
        nameNode.textContent = founderName;
        nameNode.style.color = 'var(--accent)';
        nameNode.style.textDecoration = 'none';
      } else {
        nameNode = document.createTextNode(founderName);
      }
      line.appendChild(nameNode);
      if (founderEn) line.appendChild(document.createTextNode('（' + founderEn + '）'));
      line.appendChild(document.createTextNode(' 创建'));
    }

    el.appendChild(line);
    document.body.appendChild(el);
  }

  function apply(cfg) {
    if (!cfg) return;
    config = cfg;

    // 1) 主题色
    var theme = getPath(cfg, 'brand.themeColor');
    if (theme) {
      document.documentElement.style.setProperty('--accent', theme);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', theme);
    }

    // 2) 通用注入
    document.querySelectorAll('[data-site]').forEach(function (el) {
      var value = el.getAttribute('data-site');
      var attr = el.getAttribute('data-site-attr');
      var out = render(value, cfg);
      if (attr) el.setAttribute(attr, out);
      else el.textContent = out;
    });
    // 链接地址注入（与 data-site 配合：文本用 data-site、href 用 data-site-href）
    document.querySelectorAll('[data-site-href]').forEach(function (el) {
      var href = getPath(cfg, el.getAttribute('data-site-href'));
      if (href) el.setAttribute('href', href);
    });

    // 3) 标题：data-site-title="前缀|路径"（前缀为字面量，路径取配置）或 "路径"
    var titleEl = document.querySelector('title[data-site-title]');
    if (titleEl) {
      var spec = titleEl.getAttribute('data-site-title');
      var bar = spec.indexOf('|');
      if (bar >= 0) {
        var prefix = spec.slice(0, bar);
        var val = render(spec.slice(bar + 1), cfg);
        document.title = prefix && val ? prefix + ' — ' + val : (prefix || val);
      } else {
        document.title = render(spec, cfg);
      }
    }

    // 4) 页脚署名（不可关闭；showInFooter:false 时不渲染）
    if (getPath(cfg, 'founder.showInFooter') !== false) {
      injectFooter(cfg);
    }
  }

  // 先用缓存同步渲染，再异步拉最新覆盖
  if (config) apply(config);
  fetch('/api/site-config', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (fresh) {
      if (fresh && fresh.school && fresh.school.name) {
        writeCache(fresh);
        apply(fresh);
      }
    })
    .catch(function () { /* 接口抖动：保留缓存渲染结果 */ });
})();
