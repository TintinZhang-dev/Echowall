// ===== 白标化 · 站点公开配置接口 =====
// GET /api/site-config —— 只暴露公开字段白名单，绝不返回密钥/路径/后台地址。
const express = require('express');
const router = express.Router();
const { siteConfig } = require('../config');

router.get('/site-config', (req, res) => {
  const out = {
    school: {
      name: siteConfig.school.name,
      shortName: siteConfig.school.shortName || '',
      hasClassSystem: !!siteConfig.school.hasClassSystem
    },
    product: {
      name: siteConfig.product.name,
      nameZh: siteConfig.product.nameZh || '',
      slogan: siteConfig.product.slogan || ''
    },
    brand: {
      logoText: siteConfig.brand.logoText || siteConfig.product.name,
      themeColor: siteConfig.brand.themeColor || '#1D9BF0'
    },
    support: { contactEmail: siteConfig.support.contactEmail || '' },
    domain: siteConfig.domain || ''
  };

  // founder 仅在 exposeInApi !== false 时返回（含 wechat，供申诉/重置/后台页面渲染联系方式）
  if (siteConfig.founder.exposeInApi !== false) {
    out.founder = {
      name: siteConfig.founder.name,
      nameEn: siteConfig.founder.nameEn,
      wechat: siteConfig.founder.wechat || '',
      link: siteConfig.founder.link
    };
  }

  res.json(out);
});

module.exports = router;
