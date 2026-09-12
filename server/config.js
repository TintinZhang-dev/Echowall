// ===== 白标化 · 站点配置加载（Phase A）=====
// 读取顺序：site.config.json（真实实例，不入库）→ site.config.example.json（模板，入库）
// 与内置默认值深合并：缺字段不报错，用默认值兜底。
const fs = require('fs');
const path = require('path');

// 内置默认值（深合并兜底；school.name / product.name 留空以便触发必填校验）
const DEFAULTS = {
  school: { name: '', shortName: '', hasClassSystem: true },
  product: { name: '', nameZh: '', slogan: '' },
  brand: { logoText: 'Phewall', themeColor: '#1D9BF0' },
  support: { contactEmail: '' },
  founder: {
    name: '', nameEn: '', wechat: '', link: '',
    showInFooter: true, showOnAbout: true, exposeInApi: true
  },
  registry: { boards: [] },
  domain: ''
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    for (const key of Object.keys(override)) {
      const v = override[key];
      const b = out[key];
      if (
        v && typeof v === 'object' && !Array.isArray(v) &&
        b && typeof b === 'object' && !Array.isArray(b)
      ) {
        out[key] = deepMerge(b, v);
      } else {
        out[key] = v;
      }
    }
  }
  return out;
}

function loadConfig() {
  const cwd = process.cwd();
  const realPath = path.join(cwd, 'site.config.json');
  const examplePath = path.join(cwd, 'site.config.example.json');

  let raw = '{}';
  let source = '(内置默认值)';
  if (fs.existsSync(realPath)) {
    raw = fs.readFileSync(realPath, 'utf8');
    source = realPath;
  } else if (fs.existsSync(examplePath)) {
    raw = fs.readFileSync(examplePath, 'utf8');
    source = examplePath;
  }

  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[config] 无法解析 ${source}: ${err.message}`);
    process.exit(1);
  }

  const merged = deepMerge(DEFAULTS, parsed);

  // 必填校验：school.name / product.name 缺失则打印警告并退出
  const missing = [];
  if (!merged.school || !merged.school.name) missing.push('school.name');
  if (!merged.product || !merged.product.name) missing.push('product.name');
  if (missing.length) {
    console.error(`[config] site 配置缺少必填字段：${missing.join('、')}（请检查 ${source}）`);
    process.exit(1);
  }

  console.log(`[config] 已加载站点配置：${merged.school.name} / ${merged.product.name}（来源 ${source}）`);
  return merged;
}

module.exports = { siteConfig: loadConfig() };
