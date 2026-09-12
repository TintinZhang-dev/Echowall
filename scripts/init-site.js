// ===== 白标化 · 站点初始化脚本（B2）=====
// 幂等：posts 表非空则不创建。空库时按 siteConfig.welcomePost 创建置顶欢迎帖。
// 运行：npm run init-site（须在项目根目录）
// 说明：require('../server/db') 会顺带按 config 播种板块（只增不删），因此新校部署后跑一次即可完成初始化。
const db = require('../server/db');
const { siteConfig } = require('../server/config');

function renderPlaceholders(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\{school\}/g, siteConfig.school.name)
    .replace(/\{product\}/g, siteConfig.product.name);
}

function main() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c;
  if (count > 0) {
    console.log('[init-site] posts 表已有 ' + count + ' 帖，跳过创建欢迎帖（幂等）');
    return;
  }

  const content = renderPlaceholders(siteConfig.welcomePost && siteConfig.welcomePost.content);
  if (!content) {
    console.log('[init-site] siteConfig.welcomePost.content 为空，跳过创建欢迎帖');
    return;
  }

  // 作者回退：is_admin=1 且 id 最小者 → 第一个 admin/founder → 无用户则跳过（不报错退出）
  let author = db.prepare('SELECT id, name FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
  if (!author) author = db.prepare("SELECT id, name FROM users WHERE role IN ('admin', 'founder') ORDER BY id LIMIT 1").get();
  if (!author) {
    console.log('[init-site] 无任何管理员/创始人账号，跳过创建欢迎帖（请先注册并设为 founder 后再跑）');
    return;
  }

  db.prepare(`
    INSERT INTO posts (content, nickname, ip, user_id, is_anonymous, category, pinned, onboarding)
    VALUES (?, ?, '0.0.0.0', ?, 0, 'other', 1, 1)
  `).run(content, author.name, author.id);

  console.log('[init-site] 已创建欢迎帖（作者 #' + author.id + ' ' + author.name + '，' + Buffer.byteLength(content) + ' 字节）');
}

main();
db.close();
