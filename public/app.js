const API = '';

// ===== Global error reporting (debug iOS issues) =====
window.addEventListener('error', function (e) {
  try { fetch(API + '/api/debug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: e.message, src: (e.filename || '') + ':' + e.lineno + ':' + e.colno, stack: (e.stack || '').slice(0, 800), ua: navigator.userAgent }) }); } catch (_) {}
});
window.addEventListener('unhandledrejection', function (e) {
  try { fetch(API + '/api/debug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: 'Promise: ' + String(e.reason), ua: navigator.userAgent }) }); } catch (_) {}
});

// ===== State =====
let posts = [];
let page = 1;
let loading = false;
let hasMore = true;
let currentReportPostId = null;
let expandedComments = {};
let currentUser = null; // { id, year, class_number, name, nickname, ... }
let currentCategory = 'all';
let founderView = false;
let currentFeed = 'all'; // 'all' | 'following'

// ===== Init =====
// [2026-09-06] App 内(UA 含 PhewallApp/x.y.z)处理侧边栏"安卓 App"项：
//   最新版 → 隐藏（已在 App 里，无需下载入口）；有新版本 → 显示"⬆️ 升级 vX"；浏览器 → 照旧显示下载入口
function setupInAppUi() {
  const m = navigator.userAgent.match(/PhewallApp\/([\d.]+)/);
  if (!m) return; // 普通浏览器：不动
  const appItem = document.getElementById('sidebar-app-item');
  if (!appItem) return;
  const hide = () => { appItem.style.display = 'none'; };
  fetch(API + '/api/app/version')
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (!d || !d.version || d.version === m[1]) return hide();
      const label = appItem.querySelector('.nav-label');
      if (label) label.textContent = '⬆️ 升级 v' + d.version;
      appItem.href = d.url || '/downloads/Phewall-latest.apk';
      // App 内点击升级项：优先走原生下载桥，避免 WebView 内点击无反应
      try {
        if (window.PhewallBridge && typeof window.PhewallBridge.download === 'function') {
          appItem.addEventListener('click', function (ev) {
            ev.preventDefault();
            const u = appItem.getAttribute('href');
            window.PhewallBridge.download(u.indexOf('http') === 0 ? u : location.origin + u);
          });
        }
      } catch (_) {}
    })
    .catch(hide);
}
function initApp() {
  checkAuth();
  loadPosts();
  setupCharCounter();
  setupMediaPreview();
  setupScrollObserver();
  setupInAppUi();
  maybePromptUpdate();
  // Poll DM unread count every 20s
  setInterval(function() {
    if (currentUser) loadDmCount();
  }, 20000);
}
// Use readyState guard: if the script loads late (slow network), DOMContentLoaded may have already fired
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// [2026-09-06] 记住主页滚动位置：从详情页/其他页返回时恢复，避免浏览器恢复出错跳到页面底部
(function () {
  const KEY = 'feed_scroll_pos';
  let saveTimer = null;
  const savePos = () => {
    try { sessionStorage.setItem(KEY, String(window.scrollY)); } catch (_) {}
  };
  window.addEventListener('scroll', () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; savePos(); }, 250);
  }, { passive: true });
  // 离开页面前保存一次（点帖子/切走时）
  window.addEventListener('pagehide', savePos);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });

  // 仅当通过浏览器前进/后退回到本页时恢复（直接访问/刷新不恢复）
  function restoreIfBack() {
    try {
      const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      if (!nav || nav.type !== 'back_forward') return;
      const y = parseInt(sessionStorage.getItem(KEY) || '0', 10);
      if (!y || y < 10) return;
      // 等 feed 内容渲染出来再滚（帖子异步加载，最多等 4 秒）
      let tries = 0;
      const t = setInterval(() => {
        tries++;
        if (document.body.scrollHeight > y + window.innerHeight || tries > 20) {
          clearInterval(t);
          window.scrollTo(0, y);
        }
      }, 200);
    } catch (_) {}
  }
  window.addEventListener('pageshow', restoreIfBack);
})();

// Auto-refresh feed when navigating back to the page
let lastRefresh = Date.now();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastRefresh > 30000) {
    lastRefresh = Date.now();
    // Refresh feed silently (only if user is on main timeline)
    if (!(document.getElementById('post-modal') || {}).style.display === 'flex' &&
        !(document.getElementById('report-modal') || {}).style.display === 'flex') {
      loadPosts();
    }
    // Refresh DM count
    if (currentUser) loadDmCount();
  }
});

// ===== Sidebar Toggle =====
// [2026-08-31] 修复 WebView 里点菜单无反应：
//  1) 内联 transform 兜底——之前诊断发现 click 触发了但 CSS(媒体查询/transform) 没生效
//  2) 250ms 去重——旧缓存 HTML 的内联 onclick + JS 绑定同时触发 = 连 toggle 两次 = 看似无反应
let lastMenuToggleAt = 0;
function toggleSidebar() {
  const now = Date.now();
  if (now - lastMenuToggleAt < 250) return;
  lastMenuToggleAt = now;
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar) return;
  const isOpen = sidebar.classList.toggle('open');
  // 内联兜底：不依赖 @media/transition/transform 规则也能生效
  sidebar.style.transform = isOpen ? 'translateX(0)' : 'translateX(-100%)';
  sidebar.style.transition = 'transform 0.25s ease';
  if (backdrop) backdrop.style.display = isOpen ? 'block' : 'none';
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

// [2026-08-16] 汉堡菜单唯一绑定（原来 HTML onclick + 这里双绑 → 每次点击 toggle 两次 = 看似无反应）
// [2026-08-31] 再加 document 级委托绑定：即使按钮被重渲染/绑定时机错过也能生效；
// 多个绑定同时触发时由 toggleSidebar 内部 250ms 去重合并为一次
(function () {
  const btn = document.getElementById('mobile-menu-btn') || document.querySelector('.mobile-menu-btn');
  if (btn && !btn.__menuBound) {
    btn.__menuBound = true;
    btn.addEventListener('click', function () {
      toggleSidebar();
    });
  }
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.closest) {
      const btn = t.closest('.mobile-menu-btn');
      // 只有直接绑定没覆盖到的按钮（重渲染产生的新节点）才走委托；重复触发由 toggleSidebar 去重
      if (btn && !btn.__menuBound) {
        btn.__menuBound = true;
        toggleSidebar();
      }
    }
  });
  const backdrop = document.getElementById('sidebar-backdrop');
  if (backdrop && !backdrop.__bdBound) {
    backdrop.__bdBound = true;
    backdrop.addEventListener('click', function () {
      const sb = document.getElementById('sidebar');
      if (sb && sb.classList.contains('open')) toggleSidebar();
    });
  }
})();

// ===== Image Lightbox (multi-image with navigation) =====
let lightboxState = { images: [], currentIndex: 0 };

function openLightbox(src, groupKey) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  const counter = document.getElementById('lightbox-counter');

  // Collect all images from the same group
  let images = [];
  if (groupKey) {
    const allImgs = document.querySelectorAll(`[data-lightbox-group="${groupKey}"]`);
    images = Array.from(allImgs).map(el => el.src || el.getAttribute('data-lightbox-src') || el.currentSrc);
  }
  if (images.length === 0) {
    images = [src];
  }
  const index = images.indexOf(src);
  lightboxState = { images, currentIndex: index >= 0 ? index : 0 };

  img.src = lightboxState.images[lightboxState.currentIndex];
  lb.style.display = 'flex';

  // Show/hide nav buttons
  if (lightboxState.images.length > 1) {
    prevBtn.style.display = 'flex';
    nextBtn.style.display = 'flex';
    counter.style.display = 'block';
    counter.textContent = `${lightboxState.currentIndex + 1} / ${lightboxState.images.length}`;
  } else {
    prevBtn.style.display = 'none';
    nextBtn.style.display = 'none';
    counter.style.display = 'none';
  }
}

function closeLightbox() {
  document.getElementById('lightbox').style.display = 'none';
  lightboxState = { images: [], currentIndex: 0 };
}

function lightboxNav(dir) {
  if (lightboxState.images.length === 0) return;
  lightboxState.currentIndex = (lightboxState.currentIndex + dir + lightboxState.images.length) % lightboxState.images.length;
  document.getElementById('lightbox-img').src = lightboxState.images[lightboxState.currentIndex];
  if (lightboxState.images.length > 1) {
    document.getElementById('lightbox-counter').textContent = `${lightboxState.currentIndex + 1} / ${lightboxState.images.length}`;
  }
}

// Keyboard: ESC to close, arrows to navigate
document.addEventListener('keydown', (e) => {
  const lb = document.getElementById('lightbox');
  if (!lb || lb.style.display !== 'flex') return;
  if (e.key === 'Escape') { closeLightbox(); return; }
  if (e.key === 'ArrowLeft') { lightboxNav(-1); return; }
  if (e.key === 'ArrowRight') { lightboxNav(1); return; }
});

// Touch swipe support for lightbox
(function() {
  let touchStartX = 0, touchStartY = 0;
  const lb = document.getElementById('lightbox');
  lb.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  lb.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      lightboxNav(dx > 0 ? -1 : 1);
    }
  });
})();

// Click on backdrop (not image) closes lightbox
document.getElementById('lightbox').addEventListener('click', function(e) {
  if (e.target === this) closeLightbox();
});

// Event delegation: any image click in post content area opens lightbox
document.addEventListener('click', function(e) {
  const img = e.target.closest('img');
  if (!img) return;
  // Skip if it's inside a video context or already handled
  if (img.closest('video')) return;
  if (img.closest('#lightbox')) return;
  // Check if this image has a lightbox group
  const group = img.getAttribute('data-lightbox-group');
  if (group) {
    e.stopPropagation();
    openLightbox(img.src, group);
  }
});

// Close sidebar on desktop resize
window.addEventListener('resize', () => {
  if (window.innerWidth >= 768) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-backdrop').style.display = 'none';
    document.body.style.overflow = '';
  }
});

// [2026-09-06] App 内检测到新版本 → 弹窗提示(每次启动只提示一次，用 sessionStorage 记)
let updateUrl = '';
function showUpdateModal(desc) {
  const el = document.getElementById('update-modal');
  if (!el) return;
  document.getElementById('update-modal-desc').textContent = desc;
  el.style.display = 'flex';
}
function closeUpdateModal() {
  const el = document.getElementById('update-modal');
  if (el) el.style.display = 'none';
}
function goUpdate() {
  closeUpdateModal();
  if (!updateUrl) return;
  const abs = updateUrl.indexOf('http') === 0 ? updateUrl : location.origin + updateUrl;
  try {
    // App 内：走原生下载桥(跳系统浏览器)，比 WebView 直接导航 APK 可靠
    if (window.PhewallBridge && typeof window.PhewallBridge.download === 'function') {
      window.PhewallBridge.download(abs);
      return;
    }
  } catch (_) {}
  window.location.href = abs;
}
function maybePromptUpdate() {
  const m = navigator.userAgent.match(/PhewallApp\/([\d.]+)/);
  if (!m) return;
  if (sessionStorage.getItem('upd_prompted')) return;
  sessionStorage.setItem('upd_prompted', '1'); // 本次会话只弹一次
  fetch(API + '/api/app/version')
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (!d || !d.version || d.version === m[1]) return;
      updateUrl = d.url || '/downloads/Phewall-latest.apk';
      showUpdateModal('当前版本 v' + m[1] + '，发现新版本 v' + d.version + '。更新包含新功能与问题修复，建议尽快升级。');
    })
    .catch(() => {});
}

// ===== Auth =====
function getToken() {
  return localStorage.getItem('token');
}

function checkAuth() {
  // Token is an httpOnly cookie now — always verify with server
  fetch(`${API}/api/auth/me`)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (data && data.user) {
        currentUser = data.user;
        localStorage.setItem('user', JSON.stringify(data.user));
        updateAuthUI(currentUser);
      } else {
        // Not logged in
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        currentUser = null;
        updateAuthUI(null);
      }
    })
    .catch(() => {
      // Server may be offline — keep cached user data
      const cached = localStorage.getItem('user');
      if (cached) {
        try {
          currentUser = JSON.parse(cached);
          updateAuthUI(currentUser);
        } catch {
          currentUser = null;
          updateAuthUI(null);
        }
      } else {
        currentUser = null;
        updateAuthUI(null);
      }
    });
}

function updateAuthUI(user) {
  const sidebarUser = document.getElementById('sidebar-user');
  const sidebarLogin = document.getElementById('sidebar-login');
  const sidebarPostBtn = document.getElementById('sidebar-post-btn');
  const sidebarAdmin = document.getElementById('sidebar-admin');
  const mobileNotifBtn = document.getElementById('mobile-notif-btn');
  const mobileDmBtn = document.getElementById('mobile-dm-btn');
  const loginPrompt = document.getElementById('login-prompt');

  if (user) {
    // Show sidebar user section
    sidebarUser.style.display = 'flex';
    sidebarLogin.style.display = 'none';
    sidebarPostBtn.style.display = 'block';
    mobileNotifBtn.style.display = '';
    if (mobileDmBtn) mobileDmBtn.style.display = '';
    applyFontSize(user);

    // User info
    const displayName = user.nickname || user.name;
    document.getElementById('sidebar-name').innerHTML =
      `<span style="${nickColorStyle(user)}">${escapeHtml(displayName)}</span>${levelBadgeHtml(user)}`;
    document.getElementById('sidebar-handle').textContent = `@${user.name}`;
    document.getElementById('sidebar-avatar').innerHTML = avatarHtml(user);

    // Admin link
    if (user.role === 'admin' || user.role === 'founder') {
      sidebarAdmin.style.display = 'flex';
    } else {
      sidebarAdmin.style.display = 'none';
    }

    // Founder view toggle
    const founderItem = document.getElementById('sidebar-founder');
    if (user.role === 'founder') {
      founderItem.style.display = 'flex';
    } else {
      founderItem.style.display = 'none';
    }

    // Hide login prompt
    if (loginPrompt) loginPrompt.style.display = 'none';

    // Load notification count
    loadNotificationCount();
    // Load DM unread count
    loadDmCount();
    // Check user status (suspended?)
    checkUserStatus();
  } else {
    sidebarUser.style.display = 'none';
    sidebarLogin.style.display = 'block';
    sidebarPostBtn.style.display = 'none';
    sidebarAdmin.style.display = 'none';
    mobileNotifBtn.style.display = 'none';
    if (mobileDmBtn) mobileDmBtn.style.display = 'none';
    if (loginPrompt) loginPrompt.style.display = '';
    applyFontSize(null);
  }
}

function logout() {
  fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  currentUser = null;
  updateAuthUI(null);
  showToast('已退出登录');
  // Close notification dropdown if open
  document.getElementById('notification-dropdown').style.display = 'none';
}

// ===== DM Unread Count =====
async function loadDmCount() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/dm/conversations', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    var total = 0;
    if (data.conversations) {
      for (var i = 0; i < data.conversations.length; i++) {
        total += data.conversations[i].unread_count || 0;
      }
    }

    function updateBadge(el) {
      if (!el) return;
      if (total > 0) {
        el.textContent = total > 99 ? '99+' : total;
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    }

    updateBadge(document.getElementById('sidebar-dm-badge'));
    updateBadge(document.getElementById('mobile-dm-badge'));
  } catch (err) {
    // Silently fail
  }
}

// ===== Notifications =====
async function loadNotificationCount() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/notifications', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    function updateBadge(el) {
      if (!el) return;
      if (data.unreadCount > 0) {
        el.textContent = data.unreadCount > 99 ? '99+' : data.unreadCount;
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    }

    updateBadge(document.getElementById('sidebar-badge'));
    updateBadge(document.getElementById('mobile-notif-badge'));
    const dot = document.getElementById('dropdown-unread-dot');
    if (dot) dot.style.display = data.unreadCount > 0 ? 'inline-block' : 'none';
  } catch (err) {
    // Silently fail
  }
}

async function toggleNotifications() {
  const dropdown = document.getElementById('notification-dropdown');
  if (dropdown.style.display === 'none' || !dropdown.style.display) {
    dropdown.style.display = 'block';
    await loadNotifications();
  } else {
    dropdown.style.display = 'none';
  }
}

async function loadNotifications() {
  if (!currentUser) return;
  const list = document.getElementById('notification-list');
  list.innerHTML = '<div class="spinner" style="display:inline-flex;padding:16px;"><div class="spinner-dot"></div><div class="spinner-dot"></div><div class="spinner-dot"></div></div>';

  try {
    const res = await fetch('/api/notifications', { headers: authHeaders() });
    if (!res.ok) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;padding:16px;text-align:center;">加载失败</p>';
      return;
    }
    const data = await res.json();

    if (!data.notifications || data.notifications.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;padding:16px;text-align:center;">暂无通知</p>';
    } else {
      list.innerHTML = data.notifications.map(n => {
        const unreadClass = n.is_read ? '' : ' unread';
        const time = formatTime(n.created_at);
        // [2026-08-09] Link to post for any notification with post_id (like/comment/reply)
        const postLink = (n.post_id)
          ? `<a href="/post/${n.post_id}" style="color:var(--accent);font-size:0.78rem;display:block;margin-top:2px;">查看帖子 →</a>`
          : '';
        const postIdParam = n.post_id || 0;
        return `
          <div class="notification-item${unreadClass}" onclick="markNotificationRead(${n.id}, ${postIdParam})">
            <div class="notification-item-title">${escapeHtml(n.title)}</div>
            <div class="notification-item-content">${escapeHtml(n.content)}${postLink}</div>
            <div class="notification-item-time">${time}</div>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;padding:16px;text-align:center;">加载失败</p>';
  }
}

async function markNotificationRead(id, postId) {
  try {
    await fetch(`/api/notifications/${id}/read`, {
      method: 'POST', headers: authHeaders()
    });
    loadNotificationCount();
    checkUserStatus();
    loadNotifications();
    // [2026-08-07] If notification has post_id, navigate to post
    if (postId) {
      window.location.href = `/post/${postId}`;
    }
  } catch (err) { /* silently fail */ }
}

async function markAllNotificationsRead() {
  try {
    await fetch('/api/notifications/read-all', {
      method: 'POST', headers: authHeaders()
    });
    loadNotificationCount();
    // Check user status (suspended?)
    checkUserStatus();
    loadNotifications();
  } catch (err) { /* silently fail */ }
}

// Close notification dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('notification-dropdown');
  if (!dropdown || dropdown.style.display !== 'block') return;

  const sidebarBell = document.querySelector('.sidebar-nav .nav-item .nav-icon');
  const mobileBell = document.getElementById('mobile-notif-btn');

  const clickedBell = (sidebarBell && sidebarBell.parentElement.contains(e.target)) ||
                      (mobileBell && mobileBell.contains(e.target));

  if (!dropdown.contains(e.target) && !clickedBell) {
    dropdown.style.display = 'none';
  }
});

// [2026-08-07] Markdown toolbar: wrap selection with syntax (B/I/S buttons)
function wrapMd(textareaId, before, after) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const selected = ta.value.slice(start, end);
  const replacement = selected ? before + selected + after : before + after;
  ta.setRangeText(replacement, start, end, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function authHeaders() {
  // Token is in httpOnly cookie (pw_token) — same-origin fetch sends it automatically
  return {};
}

// ===== Load Posts =====
async function loadPosts() {
  if (currentFeed === 'following') {
    return loadFollowingFeed();
  }
  if (loading || !hasMore) return;
  loading = true;

  const loadBtn = document.getElementById('load-more-btn');
  const spinner = document.getElementById('loading-spinner');
  const noMore = document.getElementById('no-more');

  loadBtn.style.display = 'none';
  spinner.style.display = 'inline-flex';

  try {
    const headers = { ...authHeaders() };
    const fv = founderView ? '&founder_view=1' : '';
    const url = currentCategory === 'all'
      ? `${API}/api/posts?page=${page}&limit=20${fv}`
      : `${API}/api/posts?cat=${currentCategory}&page=${page}&limit=20${fv}`;
    const res = await fetch(url, { headers });
    const data = await res.json();

    if (data.posts && data.posts.length > 0) {
      posts = page === 1 ? data.posts : [...posts, ...data.posts];
      renderAllPosts();
      page++;
    }

    hasMore = page <= data.totalPages;

    spinner.style.display = 'none';
    if (hasMore) {
      loadBtn.style.display = 'inline-flex';
    } else if (posts.length === 0) {
      noMore.style.display = 'none';
      showEmptyState();
    } else {
      noMore.style.display = 'block';
    }
  } catch (err) {
    console.error('Failed to load posts:', err);
    spinner.style.display = 'none';
    // Only show load button if there are already posts (don't re-show for first page)
    if (posts.length > 0) {
      loadBtn.style.display = 'inline-flex';
    }
    showToast('加载失败，请重试', 'error');
  }

  loading = false;
}

// ===== Render =====
function renderAllPosts() {
  const container = document.getElementById('post-list');
  if (posts.length === 0) {
    showEmptyState();
    return;
  }
  container.innerHTML = posts.map(p => renderPost(p)).join('');
}

function getInitials(name) {
  if (!name) return '?';
  return name[0];
}

// [2026-08-09] Avatar helper: returns <img> for custom avatars, <span> for initials
function avatarHtml(user, isAnonymous) {
  if (!isAnonymous && user && user.avatar_type === 'custom' && user.avatar_url) {
    return `<img src="${escapeHtml(user.avatar_url)}" class="avatar-img" alt="">`;
  }
  const displayName = user ? (user.nickname || user.name) : '';
  const initial = displayName ? displayName[0] : '?';
  const cls = isAnonymous ? 'avatar-anonymous' : (user ? 'avatar-initials' : 'avatar-anonymous');
  return `<span class="avatar-circle ${cls}">${escapeHtml(initial)}</span>`;
}

// [2026-08-16] 等级徽章 + 昵称颜色 + 帖子字体大小
function levelBadgeHtml(author) {
  if (!author || !author.level) return '';
  const color = author.level_color || '#9ca3af';
  const emoji = author.level_emoji || '';
  const name = author.level_name || '';
  return `<span class="level-badge" style="color:${color};" title="Lv.${author.level} ${name}">Lv.${author.level} ${emoji}</span>`;
}

function nickColorStyle(author) {
  return (author && author.nickname_color) ? `color:${author.nickname_color};` : '';
}

function applyFontSize(user) {
  const map = { small: '0.85rem', medium: '0.95rem', large: '1.05rem' };
  const size = user && user.font_size ? map[user.font_size] : null;
  if (size) document.documentElement.style.setProperty('--post-font-size', size);
  else document.documentElement.style.removeProperty('--post-font-size');
}

// [2026-08-04] 任务4: Helper to get media URLs array from a post
function getMediaUrls(post) {
  if (post.media_urls) {
    try {
      const arr = typeof post.media_urls === 'string' ? JSON.parse(post.media_urls) : post.media_urls;
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch {}
  }
  if (post.media_url) return [post.media_url];
  return [];
}

// [2026-08-04] 任务5: Lightweight Markdown rendering
// Security: HTML-escape first, then apply regex transforms on escaped text
function renderMarkdown(text) {
  if (!text) return '';
  // Normalize CRLF/CR to LF — prevents double line breaks from \r residue (2026-08-07)
  text = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let html = escapeHtml(text);

  // Step 1: Extract code blocks (```...```) into placeholders
  const codeBlocks = [];
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push('<pre><code>' + code.trim() + '</code></pre>');
    return '\x00CODEBLOCK' + (codeBlocks.length - 1) + '\x00';
  });

  // Step 2: Inline code (`...`)
  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push('<code>' + code + '</code>');
    return '\x01INLINECODE' + (inlineCodes.length - 1) + '\x01';
  });

  // Step 3: Bold (**...**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Step 4: Italic (*...*), but not inside words (avoid matching **)
  // [2026-08-31] 修复：原来 <em>$1</em> 把星号前一个字符包成斜体、丢弃真正内容，改为 $2
  html = html.replace(/(^|[^*\n])\*([^*\n]+?)\*(?!\*)/g, '<em>$2</em>');

  // Step 5: Strikethrough (~~...~~)
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Step 6: Links [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');

  // Step 7: Blockquotes — lines starting with >
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // Step 8: Double newlines → paragraph breaks
  const paragraphs = html.split(/\n\n+/);
  html = paragraphs.map(p => {
    p = p.trim();
    if (!p) return '';
    // Don't wrap if already a block element
    if (p.startsWith('<pre>') || p.startsWith('<blockquote>')) return p;
    // Single newlines within paragraph → <br>
    p = p.replace(/\n/g, '<br>');
    return '<p>' + p + '</p>';
  }).join('');

  // Step 9: Restore code blocks
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  html = html.replace(/\x01INLINECODE(\d+)\x01/g, (_, i) => inlineCodes[parseInt(i)]);

  return html;
}

// [2026-08-31] Word 文档附件卡片（下载链接；R2 已配 Content-Disposition: attachment，强制下载）
function renderDocxCard(post) {
  if (!post || !post.docx_url) return '';
  const name = post.docx_name || '文档.docx';
  return `<div class="docx-card">
    <span class="docx-icon">📄</span>
    <span class="docx-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    <a class="docx-dl" href="${escapeHtml(post.docx_url)}" rel="noopener noreferrer" target="_blank" onclick="event.stopPropagation()">下载 ⬇</a>
  </div>`;
}

// [2026-08-04] 任务4: Helper to render media HTML for a post
function renderMediaHtml(mediaUrls, opts = {}) {
  if (!mediaUrls || mediaUrls.length === 0) return '';
  const { compact, clickable, groupKey } = opts;
  const gk = groupKey || '';
  const lbAttr = (i) => gk ? ` data-lightbox-group="${escapeHtml(gk)}" data-lightbox-index="${i}"` : '';
  if (compact) {
    // Compact mode: first image with count badge
    const firstUrl = mediaUrls[0];
    const isVid = /\.(mp4|webm|mov|avi)$/i.test(firstUrl);
    const badge = mediaUrls.length > 1 ? `<span style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.65);color:#fff;font-size:0.7rem;padding:2px 6px;border-radius:10px;">共 ${mediaUrls.length} 张</span>` : '';
    if (isVid) {
      return `<div class="post-media" style="position:relative;"><video src="${escapeHtml(firstUrl)}" controls preload="metadata"></video>${badge}</div>`;
    }
    return `<div class="post-media" style="position:relative;"><img src="${escapeHtml(firstUrl)}" alt="图片" loading="lazy"${lbAttr(0)}${clickable ? ' style="cursor:pointer;"' : ''}>${badge}</div>`;
  }
  // Full grid mode for detail page
  if (mediaUrls.length === 1) {
    const url = mediaUrls[0];
    const isVid = /\.(mp4|webm|mov|avi)$/i.test(url);
    if (isVid) {
      return `<div class="post-media"><video src="${escapeHtml(url)}" controls preload="metadata"></video></div>`;
    }
    return `<div class="post-media"><img src="${escapeHtml(url)}" alt="图片" loading="lazy"${lbAttr(0)}${clickable ? ' style="cursor:pointer;"' : ''}></div>`;
  }
  // Multi-image grid
  const gridCols = mediaUrls.length <= 2 ? 2 : 3;
  return `<div class="post-media-grid" style="display:grid;grid-template-columns:repeat(${gridCols},1fr);gap:4px;margin-bottom:8px;">${
    mediaUrls.map((url, i) => {
      const isVid = /\.(mp4|webm|mov|avi)$/i.test(url);
      if (isVid) {
        return `<video src="${escapeHtml(url)}" controls preload="metadata" style="width:100%;max-height:250px;object-fit:cover;border-radius:4px;"></video>`;
      }
      return `<img src="${escapeHtml(url)}" alt="图片" loading="lazy"${lbAttr(i)} style="width:100%;height:160px;object-fit:cover;border-radius:4px;${clickable ? 'cursor:pointer;' : ''}">`;
    }).join('')
  }</div>`;
}

function renderPost(post) {
  const pinnedClass = post.pinned ? ' pinned' : '';

  // Pin badge with verification label (must be defined BEFORE authorHtml uses it)
  const pinVLabel = (post.author && post.author.verified_label) || ((post.real_author && post.real_author.verified_label)) || '';
  const pinBadge = post.pinned ? `<span class="pin-badge">📌 ${pinVLabel || '置顶'}</span>` : '';

  // [2026-08-07] Board badge
  const boardBadge = post.board ? `<a href="/board?id=${post.board.id}" class="cat-badge" style="background:rgba(29,155,240,0.08);color:var(--accent);cursor:pointer;text-decoration:none;" onclick="event.stopPropagation()">${escapeHtml(post.board.icon)} ${escapeHtml(post.board.name)}</a>` : '';

  // Category badge
  const catMap = {
    'confession': '💕 表白', 'blessing': '🎉 祝福', 'fun': '😄 整活',
    'activity': '📢 活动', 'rant': '💬 吐槽', 'advice': '💡 建议',
    'question': '❓ 求助', 'other': '不分类', 'sports': '⚽ 体育',
    'daily': '☀️ 日常', 'water': '🌊 每日一水', 'treehole': '🌳 树洞', 'friends': '🤝 交友', 'emo': '😢 emo'
  };
  const catBadge = post.category ? `<span class="cat-badge">${catMap[post.category] || '不分类'}</span>` : '';

  // Determine author display
  let authorHtml = '';
  if (post.is_anonymous) {
    const anonStyle = post.real_author ? '' : 'color:var(--text-muted);';
    const anonName = post.real_author ? escapeHtml(post.real_author.nickname || post.real_author.name) : '匿名';
    const anonBadge = post.real_author ? '<span style="font-size:0.68rem;color:var(--accent);margin-left:4px;">👁️ 已解密</span>' : '';
    const anonDetail = post.real_author ? `<span class="post-author-info">${post.real_author.year}届${post.real_author.class_number}班</span>` : '';
    const anonAvatarLink = post.real_author
      ? `<a href="/user/${post.real_author.id}" style="text-decoration:none;color:inherit;" onclick="event.stopPropagation()">${avatarHtml(post.real_author, true)}</a>`
      : avatarHtml(null, true);
    authorHtml = `
      <div class="post-card-top">
        <div class="post-avatar-col">
          ${anonAvatarLink}
        </div>
        <div class="post-body-col">
          <div class="post-meta">
            ${catBadge}${boardBadge}
            <span class="post-author-name" style="${anonStyle}">${anonName}${anonBadge}</span>
            ${anonDetail}
            <span class="post-time">${formatTime(post.created_at)}</span>
            ${post.pinned ? pinBadge : ''}
          </div>`;
  } else if (post.author) {
    const displayName = post.author.nickname || post.author.name;
    const initial = getInitials(displayName);
    const authorInfo = post.author.is_external
      ? (post.author.school ? `外校 · ${escapeHtml(post.author.school)}` : '外校')
      : `${post.author.year}届${post.author.class_number}班${post.author.verified_label ? ` · ${escapeHtml(post.author.verified_label)}` : ''}`;
    authorHtml = `
      <div class="post-card-top">
        <div class="post-avatar-col">
          <a href="/user/${post.author.id}" style="text-decoration:none;color:inherit;" onclick="event.stopPropagation()">${avatarHtml(post.author)}</a>
        </div>
        <div class="post-body-col">
          <div class="post-meta">
            ${catBadge}${boardBadge}
            <span class="post-author-name">
              <a href="/user/${post.author.id}" style="text-decoration:none;color:inherit;${nickColorStyle(post.author)}" onclick="event.stopPropagation()">${escapeHtml(displayName)}</a>
              ${levelBadgeHtml(post.author)}
              ${post.author.verified_label ? `<span class="verify-badge" title="${escapeHtml(post.author.verified_label)}">✅</span>` : ''}
            </span>
            <span class="post-author-info">${authorInfo}</span>
            <span class="post-time">${formatTime(post.created_at)}</span>
            ${post.pinned ? pinBadge : ''}
          </div>`;
  } else {
    // Legacy posts without author (both user_id null and no is_anonymous set)
    authorHtml = `
      <div class="post-card-top">
        <div class="post-avatar-col">
          ${avatarHtml(null, true)}
        </div>
        <div class="post-body-col">
          <div class="post-meta">
            ${catBadge}${boardBadge}
            <span class="post-author-name" style="color:var(--text-muted);">匿名</span>
            <span class="post-time">${formatTime(post.created_at)}</span>
            ${post.pinned ? pinBadge : ''}
          </div>`;
  }

  // [2026-08-07] Repost refactor: full-content share card
  let repostHtml = '';
  if (post.repost_of && post.repost_original) {
    const orig = post.repost_original;
    // Render original content with markdown
    const origMD = renderMarkdown(orig.content || '');
    const origPreview = renderMarkdown((orig.content || '').slice(0, 200));
    let origContentHtml = origMD;
    let origCollapseBtn = '';
    if ((orig.content || '').length > 200) {
      origContentHtml = `<span class="post-content-preview">${origPreview}…</span>`;
      origCollapseBtn = `<button class="btn btn-link collapse-btn" onclick="toggleRepostContent(${post.id})" id="repost-collapse-btn-${post.id}">展开全文 ▾</button>`;
    }
    // Render original media
    let origMediaHtml = '';
    if (post.repost_media_urls) {
      origMediaHtml = renderMediaHtml(getMediaUrls({ media_urls: post.repost_media_urls, media_url: post.repost_media_url }), { compact: true, clickable: true, groupKey: `repost-orig-${post.id}` });
    }
    // Render original poll
    let origPollHtml = '';
    if (post.repost_poll) {
      const rp = post.repost_poll;
      const totalVotes = rp.total_votes || 0;
      const hasVoted = rp.my_vote !== null && rp.my_vote !== undefined;
      origPollHtml = '<div class="poll-container" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;margin-bottom:8px;background:var(--bg-secondary);">';
      origPollHtml += `<div style="font-weight:700;font-size:0.9rem;margin-bottom:8px;">📊 ${escapeHtml(rp.question)}</div>`;
      origPollHtml += '<div style="display:flex;flex-direction:column;gap:6px;">';
      for (const opt of rp.options) {
        const pct = totalVotes > 0 ? Math.round((opt.vote_count || 0) / totalVotes * 100) : 0;
        const isMyVote = rp.my_vote === opt.id;
        if (hasVoted) {
          origPollHtml += `<div style="position:relative;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--card-bg);overflow:hidden;cursor:default;">
            <div style="position:absolute;top:0;left:0;bottom:0;background:${isMyVote ? 'rgba(29,155,240,0.2)' : 'rgba(29,155,240,0.08)'};width:${pct}%;transition:width 0.3s;border-radius:6px;"></div>
            <div style="position:relative;display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;">
              <span>${escapeHtml(opt.text)}${isMyVote ? ' ✓' : ''}</span>
              <span style="font-weight:600;color:var(--text-muted);">${pct}% (${opt.vote_count || 0}票)</span>
            </div></div>`;
        } else {
          origPollHtml += `<button class="poll-vote-btn" onclick="event.stopPropagation();votePoll(${orig.id}, ${opt.id})"
            style="display:block;width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:20px;background:var(--card-bg);color:var(--text);cursor:pointer;font-size:0.85rem;font-family:inherit;text-align:left;transition:all 0.15s;"
            onmouseenter="this.style.borderColor='var(--accent)';this.style.background='rgba(29,155,240,0.06)';"
            onmouseleave="this.style.borderColor='var(--border)';this.style.background='var(--card-bg)';">
            ${escapeHtml(opt.text)}</button>`;
        }
      }
      origPollHtml += '</div>';
      origPollHtml += `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:6px;">共 ${totalVotes} 票</div>`;
      origPollHtml += '</div>';
    }
    repostHtml = `
      <div class="repost-header" style="font-size:0.82rem;color:var(--accent);margin-bottom:6px;font-weight:600;">
        🔁 ${escapeHtml((post.author && (post.author.nickname || post.author.name)) || '用户')} 转发了
      </div>
      <div class="repost-card" id="repost-quote-${post.id}" style="border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:8px;background:var(--bg-secondary);cursor:pointer;" onclick="window.location='/post/${orig.id}'"${(orig.content || '').length > 200 ? ` data-full-content="${origMD.replace(/"/g, '&quot;')}" data-preview-content="${origPreview.replace(/"/g, '&quot;')}"` : ''}>
        <div class="repost-quote-content" id="repost-content-${post.id}">${origContentHtml}</div>
        ${origCollapseBtn}
        ${origMediaHtml}
        ${renderDocxCard(orig)}
        ${origPollHtml}
        <div style="font-size:0.78rem;color:var(--accent);margin-top:6px;">查看原帖 →</div>
      </div>`;
  } else if (post.repost_of) {
    // Legacy fallback for reposts without enriched original data
    const repostRaw = post.repost_content || '';
    const repostMD = renderMarkdown(repostRaw);
    const repostPreview = renderMarkdown(repostRaw.slice(0, 200));
    let repostContentHtml = repostMD;
    let repostCollapseBtn = '';
    if (repostRaw.length > 200) {
      repostContentHtml = `<span class="post-content-preview">${repostPreview}…</span>`;
      repostCollapseBtn = `<button class="btn btn-link collapse-btn" onclick="toggleRepostContent(${post.id})" id="repost-collapse-btn-${post.id}">展开全文 ▾</button>`;
    }
    repostHtml = `<div class="repost-quote" id="repost-quote-${post.id}"${repostRaw.length > 200 ? ` data-full-content="${repostMD.replace(/"/g, '&quot;')}" data-preview-content="${repostPreview.replace(/"/g, '&quot;')}"` : ''}>
      <div class="repost-quote-author">@${escapeHtml(post.repost_author || '用户')}</div>
      <div class="repost-quote-content" id="repost-content-${post.id}">${repostContentHtml}</div>
      ${repostCollapseBtn}
      ${post.repost_media_url ? (() => {
        const repostUrls = post.repost_media_urls ? (() => { try { const a = typeof post.repost_media_urls === 'string' ? JSON.parse(post.repost_media_urls) : post.repost_media_urls; if (Array.isArray(a)) return a; } catch {} return [post.repost_media_url]; })() : [post.repost_media_url];
        const isVid = /\.(mp4|webm|mov|avi)$/i.test(repostUrls[0]);
        const badge = repostUrls.length > 1 ? `<span style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.6);color:#fff;font-size:0.65rem;padding:1px 5px;border-radius:8px;">${repostUrls.length}图</span>` : '';
        return isVid
          ? `<div style="position:relative;"><video src="${escapeHtml(repostUrls[0])}" controls preload="metadata" style="max-height:200px;border-radius:8px;margin-top:6px;"></video>${badge}</div>`
          : `<div style="position:relative;"><img src="${escapeHtml(repostUrls[0])}" alt="转发图片" loading="lazy" style="max-height:200px;border-radius:8px;margin-top:6px;" onclick="event.stopPropagation();openLightbox(this.src)">${badge}</div>`;
      })() : ''}
    </div>`;
  }

  // [2026-08-07] Repost refactor: for reposts, actions target the original post
  const isRepostWithOriginal = !!(post.repost_of && post.repost_original);

  // [2026-08-04] 任务4: Media — multi-image support
  const mediaGroupKey = isRepostWithOriginal ? `repost-${post.id}` : `post-${post.id}`;
  const mediaHtml = renderMediaHtml(getMediaUrls(post), { compact: true, clickable: true, groupKey: mediaGroupKey });

  // [2026-08-03] 任务5: Poll rendering
  let pollHtml = '';
  if (post.poll) {
    const poll = post.poll;
    const totalVotes = poll.total_votes || 0;
    const hasVoted = poll.my_vote !== null && poll.my_vote !== undefined;
    pollHtml = '<div class="poll-container" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;margin-bottom:8px;background:var(--bg-secondary);">';
    pollHtml += `<div style="font-weight:700;font-size:0.9rem;margin-bottom:8px;">📊 ${escapeHtml(poll.question)}</div>`;
    pollHtml += '<div style="display:flex;flex-direction:column;gap:6px;">';
    for (const opt of poll.options) {
      const pct = totalVotes > 0 ? Math.round((opt.vote_count || 0) / totalVotes * 100) : 0;
      const isMyVote = poll.my_vote === opt.id;
      if (hasVoted) {
        // Show results bar
        pollHtml += `
          <div style="position:relative;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--card-bg);overflow:hidden;cursor:default;">
            <div style="position:absolute;top:0;left:0;bottom:0;background:${isMyVote ? 'rgba(29,155,240,0.2)' : 'rgba(29,155,240,0.08)'};width:${pct}%;transition:width 0.3s;border-radius:6px;"></div>
            <div style="position:relative;display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;">
              <span>${escapeHtml(opt.text)}${isMyVote ? ' ✓' : ''}</span>
              <span style="font-weight:600;color:var(--text-muted);">${pct}% (${opt.vote_count || 0}票)</span>
            </div>
          </div>`;
      } else {
        // Show vote button
        pollHtml += `
          <button class="poll-vote-btn" onclick="event.stopPropagation();votePoll(${post.id}, ${opt.id})"
            style="display:block;width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:20px;background:var(--card-bg);color:var(--text);cursor:pointer;font-size:0.85rem;font-family:inherit;text-align:left;transition:all 0.15s;"
            onmouseenter="this.style.borderColor='var(--accent)';this.style.background='rgba(29,155,240,0.06)';"
            onmouseleave="this.style.borderColor='var(--border)';this.style.background='var(--card-bg)';">
            ${escapeHtml(opt.text)}
          </button>`;
      }
    }
    pollHtml += '</div>';
    pollHtml += `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:6px;">共 ${totalVotes} 票</div>`;
    pollHtml += '</div>';
  }

  // [2026-08-07] Repost refactor: actions target the original post (declared above, before mediaGroupKey)
  const actionPostId = isRepostWithOriginal ? post.repost_original.id : post.id;
  const commentCount = isRepostWithOriginal ? (post.repost_comment_count || 0) : (post.comment_count || 0);
  const likeCount = isRepostWithOriginal ? (post.repost_like_count || 0) : (post.like_count || 0);
  const repostCount = post.repost_count || 0;
  const isExpanded = expandedComments[post.id];
  const likedClass = isRepostWithOriginal ? (post.repost_user_liked ? ' liked' : '') : (post.user_liked ? ' liked' : '');

  // [2026-08-04] 任务5: Long content auto-collapse with Markdown
  const MAX_CONTENT_LEN = 200;
  const rawContent = post.content || '';
  const markdownFull = renderMarkdown(rawContent);
  let contentHtml = markdownFull;
  let collapseBtn = '';
  let cardDataAttrs = '';
  if (rawContent.length > MAX_CONTENT_LEN) {
    const previewText = renderMarkdown(rawContent.slice(0, MAX_CONTENT_LEN));
    contentHtml = `<span class="post-content-preview">${previewText}…</span>`;
    collapseBtn = `<button class="btn btn-link collapse-btn" onclick="togglePostContent(${post.id})" id="collapse-btn-${post.id}">展开全文 ▾</button>`;
    cardDataAttrs = ` data-full-content="${markdownFull.replace(/"/g, '&quot;')}" data-preview-content="${previewText.replace(/"/g, '&quot;')}"`;
  }

  return `
    <div class="post-card${pinnedClass}" id="post-${post.id}"${cardDataAttrs} onclick="return goPostDetail(${post.id}, event)">
      ${authorHtml}
        ${repostHtml}
        <div class="post-content" id="post-content-${post.id}">${contentHtml}</div>
        ${collapseBtn}
        ${mediaHtml}
        ${renderDocxCard(post)}
        ${pollHtml}
        <div class="post-actions">
          <button class="action-btn${likedClass}" onclick="toggleLike(${actionPostId})" id="like-btn-${actionPostId}">
            <span class="action-icon">❤️</span> <span id="like-count-${actionPostId}">${likeCount}</span>
          </button>
          <a href="/post/${actionPostId}" class="action-btn" style="text-decoration:none;color:var(--text-muted);">
            <span class="action-icon">💬</span> <span id="comment-count-${actionPostId}">${commentCount}</span>
          </a>
          <button class="action-btn" onclick="repostPost(${actionPostId})">
            <span class="action-icon">🔁</span> <span id="repost-count-${actionPostId}">${repostCount}</span>
          </button>
          <button class="action-btn" onclick="openReportModal(${actionPostId})">
            <span class="action-icon">🚩</span>
          </button>
          ${post.pinned && currentUser && (post.user_id === currentUser.id || currentUser.role === 'founder' || currentUser.role === 'admin') ? '<button class="action-btn" onclick="unpinPost(' + post.id + ')" title="取消置顶" style="color:var(--accent);"><span class="action-icon">📌</span></button>' : ''}
          ${currentUser && post.user_id === currentUser.id ? '<button class="action-btn" onclick="deleteOwnPost(' + post.id + ')" style="color:var(--danger);"><span class="action-icon">🗑️</span></button>' : ''}
        </div>
      </div>
    </div>
  </div>
  `;
}

// [2026-09-06] 点击帖子卡片主体 → 进入详情页（内部可交互元素不拦截：头像/板块/按钮/图片/转发卡片等）
function goPostDetail(postId, e) {
  if (!e || !e.target || !e.target.closest) return true;
  if (e.target.closest('a, button, img, video, .repost-card, .docx-card, .collapse-btn, .post-actions, .poll-vote-btn, .post-comments')) return true;
  window.location.href = '/post/' + postId;
  return false;
}

// ===== Toggle Post Content (long content collapse) =====
function togglePostContent(postId) {
  const contentEl = document.getElementById(`post-content-${postId}`);
  const btn = document.getElementById(`collapse-btn-${postId}`);
  if (!contentEl || !btn) return;

  if (!contentEl.dataset.full) {
    const card = document.getElementById(`post-${postId}`);
    if (card && card.dataset.fullContent) {
      contentEl.dataset.full = '1';
      // [2026-08-04] 任务5: fullContent is already rendered Markdown HTML
      contentEl.innerHTML = card.dataset.fullContent;
      btn.textContent = '收起 ▲';
    }
    return;
  }

  const card = document.getElementById(`post-${postId}`);
  if (card && card.dataset.previewContent) {
    contentEl.dataset.full = '';
    // [2026-08-04] 任务5: previewContent is already rendered Markdown HTML
    contentEl.innerHTML = `<span class="post-content-preview">${card.dataset.previewContent}…</span>`;
    btn.textContent = '展开全文 ▾';
  }
}

// ===== Toggle Repost Content (long repost collapse) =====
function toggleRepostContent(postId) {
  const contentEl = document.getElementById(`repost-content-${postId}`);
  const btn = document.getElementById(`repost-collapse-btn-${postId}`);
  if (!contentEl || !btn) return;

  if (!contentEl.dataset.full) {
    const quote = document.getElementById(`repost-quote-${postId}`);
    if (quote && quote.dataset.fullContent) {
      contentEl.dataset.full = '1';
      // [2026-08-04] 任务5: fullContent is already rendered Markdown HTML
      contentEl.innerHTML = quote.dataset.fullContent;
      btn.textContent = '收起 ▲';
    }
    return;
  }

  const quote = document.getElementById(`repost-quote-${postId}`);
  if (quote && quote.dataset.previewContent) {
    contentEl.dataset.full = '';
    // [2026-08-04] 任务5: previewContent is already rendered Markdown HTML
    contentEl.innerHTML = `<span class="post-content-preview">${quote.dataset.previewContent}…</span>`;
    btn.textContent = '展开全文 ▾';
  }
}

// ===== Toggle Like =====
async function toggleLike(postId) {
  if (!currentUser) {
    showToast('请先登录', 'error');
    return;
  }

  try {
    const res = await fetch(`${API}/api/posts/${postId}/like`, {
      method: 'POST',
      headers: { ...authHeaders() }
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '请先登录', 'error');
      return;
    }
    const data = await res.json();
    const countEl = document.getElementById(`like-count-${postId}`);
    const btnEl = document.getElementById(`like-btn-${postId}`);
    if (countEl) countEl.textContent = data.count;
    if (btnEl) {
      if (data.liked) {
        btnEl.classList.add('liked');
      } else {
        btnEl.classList.remove('liked');
      }
    }
  } catch (err) {
    console.error('Failed to toggle like:', err);
    showToast('操作失败', 'error');
  }
}

// ===== Comments =====
async function toggleComments(postId) {
  const container = document.getElementById(`comments-${postId}`);
  const isExpanded = expandedComments[postId];

  if (isExpanded) {
    container.style.display = 'none';
    expandedComments[postId] = false;
    return;
  }

  expandedComments[postId] = true;
  container.style.display = 'block';
  await loadComments(postId);
}

async function loadComments(postId) {
  const container = document.getElementById(`comments-${postId}`);
  container.innerHTML = '<div class="spinner" style="display:inline-flex;"><div class="spinner-dot"></div><div class="spinner-dot"></div><div class="spinner-dot"></div></div>';

  try {
    const headers = { ...authHeaders() };
    const res = await fetch(`${API}/api/posts/${postId}/comments`, { headers });
    const data = await res.json();

    let html = '';
    if (data.comments && data.comments.length > 0) {
      html += data.comments.map(c => renderComment(c, postId)).join('');
    } else {
      html += '<p style="color:var(--text-muted);font-size:0.85rem;padding:8px 0;">暂无评论</p>';
    }

    // Only show comment input if logged in
    if (currentUser) {
      html += `
        <div class="comment-input-area">
          <input type="text" class="comment-input" id="comment-input-${postId}" placeholder="写评论..." maxlength="500">
          <label class="comment-anon-label" title="匿名评论，其他人看不到你的名字">
            <input type="checkbox" id="comment-anon-${postId}" class="comment-anon-check"> 匿名
          </label>
          <button class="comment-submit" onclick="submitComment(${postId})">发送</button>
        </div>
      `;
    } else {
      html += `
        <p style="color:var(--text-muted);font-size:0.82rem;padding:8px 0;">
          <a href="/login" style="color:var(--accent);">登录</a> 后才能评论
        </p>
      `;
    }

    container.innerHTML = html;
  } catch (err) {
    console.error('Failed to load comments:', err);
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">加载评论失败</p>';
  }
}

function renderComment(comment, postId) {
  const isAnon = comment.is_anonymous === 1 || comment.is_anonymous === '1';
  const author = comment.nickname || (comment.author ? (comment.author.nickname || comment.author.name) : null) || '匿名';
  const displayAuthor = isAnon
    ? '<span style="color:var(--text-muted);">匿名</span>'
    : (typeof comment.author === 'object' && comment.author
      ? `<span style="${nickColorStyle(comment.author)}">${escapeHtml(comment.author.nickname || comment.author.name)}</span>${levelBadgeHtml(comment.author)}`
      : escapeHtml(author));
  const likeCount = comment.like_count || 0;
  const likedClass = comment.user_liked ? ' liked' : '';
  const canDelete = currentUser && (comment.user_id === currentUser.id || currentUser.role === 'founder' || currentUser.role === 'admin'); // [2026-08-04] 任务3
  const commentAuthor = isAnon ? null : (typeof comment.author === 'object' ? comment.author : null);
  const avatarEl = isAnon ? avatarHtml(null, true) : avatarHtml(commentAuthor);

  return `
    <div class="comment-item" id="comment-${comment.id}">
      <div class="comment-header">
        <span class="comment-avatar">${avatarEl}</span>
        <span class="comment-nickname">${displayAuthor}</span>
        <span class="comment-time">${formatTime(comment.created_at)}</span>
      </div>
      <div class="comment-content">${renderMarkdown(comment.content)}</div>
      <div class="comment-actions">
        <button class="action-btn${likedClass}" onclick="toggleCommentLike(${comment.id}, ${postId})" style="font-size:0.75rem;padding:2px 8px;">
          👍 <span id="clike-${comment.id}">${likeCount}</span>
        </button>
        <button class="comment-reply-btn" onclick="toggleReplyInput(${comment.id}, ${postId})">回复</button>
        ${canDelete ? `<button class="comment-reply-btn" onclick="deleteComment(${comment.id}, ${postId})" style="color:var(--danger);">🗑️ 删除</button>` : ''}
      </div>
      <div id="reply-input-${comment.id}" style="display:none;" class="reply-input-area">
        <input type="text" class="comment-input" id="reply-text-${comment.id}" placeholder="回复..." maxlength="500">
        <label class="comment-anon-label" title="匿名回复，其他人看不到你的名字">
          <input type="checkbox" id="reply-anon-${comment.id}" class="comment-anon-check"> 匿名
        </label>
        <button class="comment-submit" onclick="submitReply(${comment.id}, ${postId})">发送</button>
      </div>
      ${comment.replies && comment.replies.length > 0 ? `
        <div class="replies-section">
          ${comment.replies.map(r => renderReply(r, postId)).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderReply(reply, postId) {
  const isAnon = reply.is_anonymous === 1 || reply.is_anonymous === '1';
  const author = reply.nickname || (reply.author ? (reply.author.nickname || reply.author.name) : null) || '匿名';
  const displayAuthor = isAnon
    ? '<span style="color:var(--text-muted);">匿名</span>'
    : (typeof reply.author === 'object' && reply.author
      ? `<span style="${nickColorStyle(reply.author)}">${escapeHtml(reply.author.nickname || reply.author.name)}</span>${levelBadgeHtml(reply.author)}`
      : escapeHtml(author));
  const likeCount = reply.like_count || 0;
  const likedClass = reply.user_liked ? ' liked' : '';
  const canDelete = currentUser && (reply.user_id === currentUser.id || currentUser.role === 'founder' || currentUser.role === 'admin'); // [2026-08-04] 任务3
  const replyAuthor = isAnon ? null : (typeof reply.author === 'object' ? reply.author : null);
  const avatarEl = isAnon ? avatarHtml(null, true) : avatarHtml(replyAuthor);

  return `
    <div class="reply-item" id="comment-${reply.id}">
      <div class="comment-header">
        <span class="comment-avatar">${avatarEl}</span>
        <span class="comment-nickname">${displayAuthor}</span>
        <span class="comment-time">${formatTime(reply.created_at)}</span>
      </div>
      <div class="comment-content">${renderMarkdown(reply.content)}</div>
      <div class="comment-actions">
        <button class="action-btn${likedClass}" onclick="toggleCommentLike(${reply.id}, ${postId})" style="font-size:0.75rem;padding:2px 8px;">
          👍 <span id="clike-${reply.id}">${likeCount}</span>
        </button>
        ${canDelete ? `<button class="comment-reply-btn" onclick="deleteComment(${reply.id}, ${postId})" style="color:var(--danger);">🗑️ 删除</button>` : ''}
      </div>
    </div>
  `;
}

async function submitComment(postId, parentCommentId) {
  if (!currentUser) {
    showToast('请先登录', 'error');
    return;
  }

  const inputId = parentCommentId ? `reply-text-${parentCommentId}` : `comment-input-${postId}`;
  const anonCheckId = parentCommentId ? `reply-anon-${parentCommentId}` : `comment-anon-${postId}`;
  const input = document.getElementById(inputId);
  const content = (input && input.value && input.value.trim());
  if (!content) return;

  const anonCheck = document.getElementById(anonCheckId);
  const isAnonymous = anonCheck ? anonCheck.checked : false;

  const body = { content, is_anonymous: isAnonymous ? 1 : 0 };
  if (parentCommentId) {
    body.parent_comment_id = parentCommentId;
  }

  try {
    const res = await fetch(`${API}/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '评论失败', 'error');
      return;
    }
    input.value = '';
    // Hide reply input if it was a reply
    if (parentCommentId) {
      document.getElementById(`reply-input-${parentCommentId}`).style.display = 'none';
    }
    // Update comment count
    const countEl = document.getElementById(`comment-count-${postId}`);
    if (countEl) {
      countEl.textContent = parseInt(countEl.textContent) + 1;
    }
    // Reload comments
    await loadComments(postId);
  } catch (err) {
    console.error('Failed to submit comment:', err);
    showToast('评论失败，请重试', 'error');
  }
}

function toggleReplyInput(commentId, postId) {
  const area = document.getElementById(`reply-input-${commentId}`);
  if (area.style.display === 'none' || !area.style.display) {
    area.style.display = 'flex';
    document.getElementById(`reply-text-${commentId}`).focus();
  } else {
    area.style.display = 'none';
  }
}

async function submitReply(commentId, postId) {
  await submitComment(postId, commentId);
}

async function toggleCommentLike(commentId, postId) {
  if (!currentUser) {
    showToast('请先登录', 'error');
    return;
  }

  try {
    const res = await fetch(`${API}/api/posts/${postId}/comments/${commentId}/like`, {
      method: 'POST',
      headers: { ...authHeaders() }
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '操作失败', 'error');
      return;
    }
    const data = await res.json();
    const countEl = document.getElementById(`clike-${commentId}`);
    if (countEl) countEl.textContent = data.count;
  } catch (err) {
    console.error('Failed to toggle comment like:', err);
    showToast('操作失败', 'error');
  }
}

// [2026-08-04] 任务3: Delete comment
async function deleteComment(commentId, postId) {
  if (!confirm('确定删除这条评论？')) return;
  try {
    const res = await fetch(`/api/posts/comments/${commentId}`, {
      method: 'DELETE', headers: authHeaders()
    });
    if (!res.ok) { const e = await res.json(); showToast(e.error || '删除失败', 'error'); return; }
    // Remove from DOM
    const el = document.getElementById(`comment-${commentId}`);
    if (el) el.remove();
    showToast('已删除', 'success');
  } catch { showToast('删除失败', 'error'); }
}

// [2026-08-03] 任务5: Poll voting
async function votePoll(postId, optionId) {
  if (!currentUser) { showToast('请先登录', 'error'); return; }
  try {
    const res = await fetch(`/api/posts/${postId}/poll/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ option_id: optionId })
    });
    if (!res.ok) { const e = await res.json(); showToast(e.error || '投票失败', 'error'); return; }
    // Refresh the post's poll rendering by updating posts array and re-rendering
    const data = await res.json();
    const post = posts.find(p => p.id === postId);
    if (post && post.poll) {
      post.poll.options = data.options;
      post.poll.total_votes = data.total_votes;
      post.poll.my_vote = data.my_vote;
    }
    renderAllPosts();
  } catch { showToast('投票失败', 'error'); }
}

async function repostPost(postId) {
  if (!currentUser) {
    showToast('请先登录', 'error');
    return;
  }

  try {
    const res = await fetch(`${API}/api/posts/${postId}/repost`, {
      method: 'POST',
      headers: { ...authHeaders() }
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '转发失败', 'error');
      return;
    }
    const data = await res.json();
    document.getElementById(`repost-count-${postId}`).textContent = data.repost_count;
    showToast('已转发', 'success');
  } catch (err) {
    console.error('Failed to repost:', err);
    showToast('转发失败，请重试', 'error');
  }
}

async function deleteOwnPost(postId) {
  if (!confirm('确定要删除这条帖子吗？此操作不可撤销。')) return;
  try {
    const res = await fetch(`${API}/api/posts/${postId}/delete`, {
      method: 'POST',
      headers: { ...authHeaders() }
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '删除失败', 'error');
      return;
    }
    // Remove from local list and re-render
    posts = posts.filter(p => p.id !== postId);
    renderAllPosts();
    showToast('已删除', 'success');
  } catch (err) {
    console.error('Failed to delete post:', err);
    showToast('删除失败，请重试', 'error');
  }
}

// [2026-08-09] Unpin a post — author or admin/founder can cancel pin
async function unpinPost(postId) {
  if (!confirm('确定取消置顶这条帖子？')) return;
  try {
    const res = await fetch(`${API}/api/posts/${postId}/unpin`, {
      method: 'POST',
      headers: { ...authHeaders() }
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || '取消失败', 'error');
      return;
    }
    showToast('已取消置顶', 'success');
    posts = posts.map(p => p.id === postId ? { ...p, pinned: 0 } : p);
    renderAllPosts();
  } catch (err) {
    console.error('Failed to unpin post:', err);
    showToast('取消失败，请重试', 'error');
  }
}

function toggleFounderView() {
  founderView = !founderView;
  const icon = document.getElementById('founder-icon');
  const label = document.getElementById('founder-label');
  if (founderView) {
    icon.textContent = '🕵️‍♂️';
    label.textContent = '🔍 解密模式';
  } else {
    icon.textContent = '🕵️';
    label.textContent = '匿名解密';
  }
  // Reload posts
  page = 1;
  posts = [];
  hasMore = true;
  document.getElementById('no-more').style.display = 'none';
  loadPosts();
  showToast(founderView ? '已开启解密模式' : '已关闭解密模式', 'success');
}

// ===== Follow System =====
async function toggleFollow(userId) {
  try {
    const res = await fetch(`/api/follow/${userId}`, { method: 'POST', headers: authHeaders() });
    if (!res.ok) { const e = await res.json(); showToast(e.error || '请先登录', 'error'); return; }
    const data = await res.json();
    const btn = document.getElementById(`follow-btn-${userId}`);
    if (btn) {
      btn.textContent = data.following ? '已关注' : '关注';
      btn.classList.toggle('following', data.following);
      btn.classList.toggle('not-following', !data.following);
    }
    showToast(data.following ? '已关注' : '已取消关注', 'success');
  } catch { showToast('操作失败', 'error'); }
}

async function switchToFollowing() {
  if (!currentUser) { showToast('请先登录', 'error'); return; }
  currentFeed = 'following';
  currentCategory = 'all';
  page = 1;
  posts = [];
  hasMore = true;
  document.getElementById('no-more').style.display = 'none';
  document.getElementById('post-list').innerHTML = '';

  // Update nav active states
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('sidebar-following').classList.add('active');

  // [2026-08-07] Hide category bar, show back button in following feed
  document.getElementById('cat-bar-inner').style.display = 'none';
  document.getElementById('follow-back-btn').style.display = 'inline-flex';
  document.getElementById('manage-following-area').style.display = 'block';
  // Hide scroll buttons
  document.querySelectorAll('.cat-scroll-btn').forEach(b => b.style.display = 'none');

  loadPosts();
}

let followingListLoaded = false;

async function toggleFollowingList() {
  const list = document.getElementById('following-list');
  const area = document.getElementById('manage-following-area');
  if (!list) return;
  if (list.style.display === 'none' || !list.style.display) {
    list.style.display = 'block';
    if (!followingListLoaded) {
      await loadFollowingList();
    }
  } else {
    list.style.display = 'none';
  }
}

async function loadFollowingList() {
  const listEl = document.getElementById('following-list');
  if (!listEl) return;
  listEl.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);padding:8px;">加载中...</p>';
  try {
    const res = await fetch('/api/follow/following', { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');
    const users = data.users || [];
    followingListLoaded = true;
    if (!users.length) {
      listEl.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);padding:8px;">你还没有关注任何人<br>去 <a href="/search" style="color:var(--accent);">搜索</a> 发现同学吧</p>';
      return;
    }
    listEl.innerHTML = users.map(u => {
      const displayName = u.nickname || u.name;
      const avatar = (u.avatar_type === 'custom' && u.avatar_url)
        ? `<img src="${escapeHtml(u.avatar_url)}" class="avatar-img" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" alt="">`
        : `<span class="avatar-circle avatar-initials" style="width:36px;height:36px;font-size:0.9rem;">${escapeHtml(displayName[0] || '?')}</span>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid var(--border,#f0f0f0);">
        <a href="/user/${u.id}" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:10px;flex:1;min-width:0;" onclick="event.stopPropagation()">
          ${avatar}
          <div style="min-width:0;">
            <div style="font-weight:600;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);">${u.is_external ? '外校用户' : u.year+'届'+u.class_number+'班'}</div>
          </div>
        </a>
        <button class="btn btn-secondary" style="font-size:0.78rem;padding:4px 10px;flex-shrink:0;" onclick="unfollowFromList(${u.id}, this)">取消关注</button>
      </div>`;
    }).join('');
  } catch (err) {
    listEl.innerHTML = '<p style="font-size:0.85rem;color:var(--danger);padding:8px;">加载失败，请重试</p>';
  }
}

async function unfollowFromList(userId, btn) {
  if (!confirm('确定取消关注吗？')) return;
  try {
    const res = await fetch(`/api/follow/${userId}`, { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (data.following === false) {
      btn.closest('div').remove();
      showToast('已取消关注', 'success');
    } else {
      showToast('操作失败', 'error');
    }
  } catch (err) {
    showToast('网络错误', 'error');
  }
}

function switchBackToAll() {
  currentFeed = 'all';
  currentCategory = 'all';
  page = 1;
  posts = [];
  hasMore = true;
  document.getElementById('no-more').style.display = 'none';
  document.getElementById('post-list').innerHTML = '';

  // Reset nav
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => el.classList.remove('active'));
  const homeLink = document.querySelector('.sidebar-nav .nav-item[data-page="home"]');
  if (homeLink) homeLink.classList.add('active');

  // [2026-08-07] Show category bar, hide back button
  document.getElementById('cat-bar-inner').style.display = '';
  document.getElementById('follow-back-btn').style.display = 'none';
  document.getElementById('manage-following-area').style.display = 'none';
  document.querySelectorAll('.cat-scroll-btn').forEach(b => b.style.display = '');
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  const allBtn = document.querySelector('.cat-btn[data-cat="all"]');
  if (allBtn) allBtn.classList.add('active');

  loadPosts();
}

async function loadFollowingFeed() {
  if (!currentUser || loading || !hasMore) return;
  loading = true;

  const loadBtn = document.getElementById('load-more-btn');
  const spinner = document.getElementById('loading-spinner');
  const noMore = document.getElementById('no-more');

  loadBtn.style.display = 'none';
  spinner.style.display = 'inline-flex';

  try {
    const res = await fetch(`/api/follow/feed?page=${page}&limit=20`, { headers: authHeaders() });
    const data = await res.json();

    if (data.posts && data.posts.length > 0) {
      posts = page === 1 ? data.posts : [...posts, ...data.posts];
      renderAllPosts();
      page++;
    }

    hasMore = page <= data.totalPages;

    spinner.style.display = 'none';
    if (hasMore) {
      loadBtn.style.display = 'inline-flex';
    } else if (posts.length === 0) {
      document.getElementById('post-list').innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">👥</div>
          <p class="empty-state-text">关注你感兴趣的用户，这里会显示他们的最新动态</p>
          <p style="color:var(--text-muted);font-size:0.85rem;margin-top:8px;">去 <a href="/search">搜索</a> 发现用户</p>
        </div>
      `;
    } else {
      noMore.style.display = 'block';
    }
  } catch (err) {
    spinner.style.display = 'none';
    loadBtn.style.display = 'inline-flex';
    showToast('加载失败，请重试', 'error');
  }

  loading = false;
}

function switchCat(cat) {
  currentFeed = 'all';
  currentCategory = cat;

  // Reset nav active
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => el.classList.remove('active'));
  const homeLink = document.querySelector('.sidebar-nav .nav-item[data-page="home"]');
  if (homeLink) homeLink.classList.add('active');

  // [2026-08-07] Restore category bar visibility when switching categories
  document.getElementById('cat-bar-inner').style.display = '';
  document.getElementById('follow-back-btn').style.display = 'none';
  document.querySelectorAll('.cat-scroll-btn').forEach(b => b.style.display = '');

  // Update active button
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
  // Reset and reload
  page = 1;
  posts = [];
  hasMore = true;
  document.getElementById('no-more').style.display = 'none';
  loadPosts();
}

function scrollCat(dir) {
  const container = document.getElementById('cat-bar-inner');
  if (container) container.scrollBy({ left: dir * 200, behavior: 'smooth' });
}

// ===== Report =====
function openReportModal(postId) {
  if (!currentUser) {
    showToast('请先登录', 'error');
    return;
  }
  currentReportPostId = postId;
  document.getElementById('report-modal').style.display = 'flex';
  document.getElementById('report-reason').value = '';
  document.getElementById('report-error').style.display = 'none';
}

function closeReportModal() {
  document.getElementById('report-modal').style.display = 'none';
  currentReportPostId = null;
}

async function submitReport() {
  const opt = document.querySelector('input[name="report-reason-opt"]:checked');
  const optValue = opt ? opt.value : '其他';
  const involvesMe = optValue === '涉及自己';
  const details = document.getElementById('report-reason').value.trim();
  if (involvesMe && !details) { showToast('请补充说明你与该内容的关系', 'error'); return; }
  const reason = involvesMe ? '涉及自己' + (details ? '：' + details : '') : (optValue + (details ? '：' + details : ''));
  try {
    const res = await fetch(`${API}/api/posts/${currentReportPostId}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({ reason, involves_me: involvesMe })
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '举报失败', 'error');
      return;
    }
    closeReportModal();
    showToast('举报成功，感谢您的反馈', 'success');
  } catch (err) {
    console.error('Failed to report:', err);
    showToast('举报失败，请重试', 'error');
  }
}

// ===== Post Modal =====
// [2026-08-03] 任务5: Poll UI helpers
function togglePollSection() {
  const checked = document.getElementById('post-has-poll').checked;
  document.getElementById('poll-section').style.display = checked ? 'block' : 'none';
}

function addPollOption() {
  const container = document.getElementById('poll-options-container');
  const current = container.querySelectorAll('.poll-option-input').length;
  if (current >= 8) { showToast('最多 8 个选项', 'error'); return; }
  const row = document.createElement('div');
  row.className = 'poll-option-row';
  row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;';
  row.innerHTML = `
    <input type="text" class="form-input poll-option-input" placeholder="选项 ${current + 1}" maxlength="100" style="flex:1;">
    <button type="button" class="btn btn-secondary" onclick="removePollOption(this)" style="font-size:0.78rem;padding:4px 10px;flex-shrink:0;">✕</button>
  `;
  container.appendChild(row);
  document.getElementById('add-poll-option-btn').style.display = current + 1 >= 8 ? 'none' : '';
}

function removePollOption(btn) {
  const container = document.getElementById('poll-options-container');
  if (container.querySelectorAll('.poll-option-input').length <= 2) {
    showToast('至少需要 2 个选项', 'error');
    return;
  }
  btn.closest('.poll-option-row').remove();
  document.getElementById('add-poll-option-btn').style.display = '';
  // Renumber placeholders
  const inputs = container.querySelectorAll('.poll-option-input');
  inputs.forEach((inp, i) => { inp.placeholder = `选项 ${i + 1}`; });
}

function openPostModal() {
  if (!currentUser) {
    showToast('请先登录', 'error');
    return;
  }
  document.getElementById('post-modal').style.display = 'flex';
  document.getElementById('post-content').value = '';
  document.getElementById('post-media').value = '';
  // [2026-08-31] 重置 Word 附件
  const docxEl = document.getElementById('post-docx');
  const docxPrev = document.getElementById('docx-preview');
  if (docxEl) docxEl.value = '';
  if (docxPrev) { docxPrev.style.display = 'none'; docxPrev.innerHTML = ''; }
  document.getElementById('post-anonymous').checked = false;
  const extHiddenEl = document.getElementById('post-ext-hidden');
  if (extHiddenEl) extHiddenEl.checked = false;
  document.getElementById('media-preview').style.display = 'none';
  document.getElementById('media-preview').innerHTML = '';
  document.getElementById('post-error').style.display = 'none';
  document.getElementById('submit-btn').disabled = false;
  document.getElementById('char-count').textContent = '0';
  // [2026-08-03] 任务5: reset poll fields
  const pollCheck = document.getElementById('post-has-poll');
  if (pollCheck) pollCheck.checked = false;
  document.getElementById('poll-section').style.display = 'none';
  document.getElementById('poll-question').value = '';
  const pollContainer = document.getElementById('poll-options-container');
  pollContainer.innerHTML = `
    <div class="poll-option-row" style="display:flex;gap:6px;margin-bottom:6px;">
      <input type="text" class="form-input poll-option-input" placeholder="选项 1" maxlength="100" style="flex:1;">
    </div>
    <div class="poll-option-row" style="display:flex;gap:6px;margin-bottom:6px;">
      <input type="text" class="form-input poll-option-input" placeholder="选项 2" maxlength="100" style="flex:1;">
    </div>
  `;
  document.getElementById('add-poll-option-btn').style.display = '';

  // Show identity info
  const identityInfo = document.getElementById('post-identity-info');
  if (currentUser) {
    identityInfo.style.display = 'flex';
    const displayName = currentUser.nickname || currentUser.name;
    document.getElementById('modal-author-name').textContent = displayName;
    document.getElementById('modal-author-detail').textContent = `${currentUser.year}届${currentUser.class_number}班`;
    document.getElementById('modal-avatar').innerHTML = avatarHtml(currentUser);
  }

  // Pin checkbox — only for verified users
  const pinRow = document.getElementById('post-pin-row');
  const pinCheckbox = document.getElementById('post-pin');
  if (currentUser && (currentUser.verified_label || currentUser.is_verified)) {
    pinRow.style.display = 'flex';
    pinCheckbox.checked = false;
  } else {
    pinRow.style.display = 'none';
    pinCheckbox.checked = false;
  }

  // [2026-08-16] 置顶特权（Lv.4+）
  loadPinPrivilege();

  // Anonymous toggle: hide identity when checked
  const anonCheckbox = document.getElementById('post-anonymous');
  anonCheckbox.onchange = function() {
    identityInfo.style.display = this.checked ? 'none' : 'flex';
  };
}

function closePostModal() {
  document.getElementById('post-modal').style.display = 'none';
}

// [2026-08-16] 加载置顶特权余额与时长提示
async function loadPinPrivilege() {
  const row = document.getElementById('post-privilege-pin-row');
  const hint = document.getElementById('post-privilege-pin-hint');
  const check = document.getElementById('post-privilege-pin');
  if (!row || !check) return;
  check.checked = false;
  check.disabled = false;
  row.style.display = 'none';
  if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
  if (!currentUser) return;
  try {
    const res = await fetch('/api/points', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (data.pin) {
      const periodLabel = data.pin.period === 'daily' ? '今日' : '本周';
      const durLabel = data.pin.duration_hours >= 24
        ? (data.pin.duration_hours / 24) + ' 天'
        : data.pin.duration_hours + ' 小时';
      row.style.display = 'flex';
      if (hint) {
        hint.textContent = `${periodLabel}可用置顶次数 ${data.pin.remaining} 次 · 每次置顶时长 ${durLabel}`;
        hint.style.display = 'block';
        if (data.pin.remaining <= 0) {
          hint.textContent += '（已用完）';
          hint.style.color = 'var(--danger)';
          check.disabled = true;
        } else {
          hint.style.color = 'var(--text-muted)';
        }
      }
    }
  } catch (err) { /* 静默失败 */ }
}

// ===== Message Modal =====
function openMessageModal() {
  document.getElementById('message-modal').style.display = 'flex';
  document.getElementById('message-content').value = '';
  document.getElementById('message-char-count').textContent = '0';
  document.getElementById('message-error').style.display = 'none';
  document.getElementById('message-submit-btn').disabled = false;
  document.getElementById('message-content').focus();
  loadMyMessages();
}

// Load current user's message history with founder replies
async function loadMyMessages() {
  const container = document.getElementById('my-messages');
  const list = document.getElementById('my-messages-list');
  if (!container || !list) return;
  try {
    const res = await fetch('/api/messages/my', { headers: authHeaders() });
    if (!res.ok) { container.style.display = 'none'; return; }
    const data = await res.json();
    const msgs = data.messages || [];
    if (msgs.length === 0) { container.style.display = 'none'; return; }
    container.style.display = 'block';
    list.innerHTML = msgs.map(m => {
      const replied = m.reply ? `<div style="margin-top:6px;padding:6px 8px;background:rgba(83,87,160,0.08);border-radius:6px;font-size:0.85rem;">
        <span style="font-weight:600;color:var(--accent);">站长回复：</span>${escapeHtml(m.reply)}</div>` : '';
      return `<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border);">
        <div style="font-size:0.82rem;color:var(--text-muted);">${formatTime(m.created_at)}</div>
        <div style="font-size:0.88rem;margin-top:2px;">${escapeHtml(m.content)}</div>
        ${replied}
      </div>`;
    }).join('');
  } catch (err) {
    container.style.display = 'none';
  }
}

function closeMessageModal() {
  document.getElementById('message-modal').style.display = 'none';
}

async function submitMessage() {
  const content = document.getElementById('message-content').value.trim();
  const errorEl = document.getElementById('message-error');
  const btn = document.getElementById('message-submit-btn');

  errorEl.style.display = 'none';

  if (!content) {
    errorEl.textContent = '请输入留言内容';
    errorEl.style.display = 'block';
    return;
  }

  if (content.length > 500) {
    errorEl.textContent = '留言内容不能超过 500 字';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = '发送中...';

  try {
    const headers = { 'Content-Type': 'application/json', ...authHeaders() };
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content })
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || '发送失败';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = '发送留言';
      return;
    }

    closeMessageModal();
    showToast('留言已发送，感谢反馈！', 'success');
  } catch (err) {
    errorEl.textContent = '网络错误，请重试';
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '发送留言';
  }
}

// Setup message char counter
(function() {
  const textarea = document.getElementById('message-content');
  const counter = document.getElementById('message-char-count');
  if (textarea && counter) {
    textarea.addEventListener('input', () => {
      counter.textContent = textarea.value.length;
    });
  }
})();

async function submitPost() {
  if (!currentUser) {
    showToast('请先登录', 'error');
    return;
  }

  const contentEl = document.getElementById('post-content');
  const mediaEl = document.getElementById('post-media');
  const anonymousEl = document.getElementById('post-anonymous');
  const extHiddenEl = document.getElementById('post-ext-hidden');
  const errorEl = document.getElementById('post-error');
  const submitBtn = document.getElementById('submit-btn');

  const content = contentEl.value.trim();
  if (!content) {
    errorEl.textContent = '内容不能为空';
    errorEl.style.display = 'block';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '发布中...';
  errorEl.style.display = 'none';

  try {
    const formData = new FormData();
    formData.append('content', content);
    formData.append('is_anonymous', anonymousEl.checked ? '1' : '0');
    formData.append('category', document.getElementById('post-category').value);
    formData.append('is_pinned', document.getElementById('post-pin').checked ? '1' : '0');
    const privPinEl = document.getElementById('post-privilege-pin');
    if (privPinEl && privPinEl.checked) formData.append('use_privilege_pin', '1');
    if (extHiddenEl) formData.append('external_hidden', extHiddenEl.checked ? '1' : '0');
    // [2026-08-03] 任务5: poll data
    const hasPoll = (document.getElementById('post-has-poll') || {}).checked;
    if (hasPoll) {
      const pollQ = document.getElementById('poll-question').value.trim();
      const pollOpts = [];
      document.querySelectorAll('.poll-option-input').forEach(inp => {
        const t = inp.value.trim();
        if (t) pollOpts.push({ text: t });
      });
      if (pollQ && pollOpts.length >= 2 && pollOpts.length <= 8) {
        formData.append('poll_question', pollQ);
        formData.append('poll_options', JSON.stringify(pollOpts));
      } else if (pollQ || pollOpts.some(o => o.text)) {
        errorEl.textContent = '投票需要填写问题且至少 2 个有效选项';
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = '发布';
        return;
      }
    }
    // [2026-08-04] 任务4: Send multiple files
    if (mediaEl.files && mediaEl.files.length > 0) {
      for (const f of mediaEl.files) {
        formData.append('mediaFiles', f);
      }
    }
    // [2026-08-31] Word 文档附件（服务端会做防宏病毒校验）
    const docxEl = document.getElementById('post-docx');
    if (docxEl && docxEl.files && docxEl.files.length > 0) {
      formData.append('mediaFiles', docxEl.files[0]);
    }

    const res = await fetch(`${API}/api/posts`, {
      method: 'POST',
      headers: { ...authHeaders() },
      body: formData
    });

    if (!res.ok) {
      const err = await res.json();
      errorEl.textContent = err.error || '发布失败';
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = '发布';
      return;
    }

    closePostModal();
    showToast('发布成功！', 'success');

    // Prepend the new post to existing list instead of full reload
    const resData = await res.json();
    if (resData && resData.id) {
      // Construct enriched post from create response + defaults
      const newPost = {
        ...resData,
        like_count: 0,
        comment_count: 0,
        repost_count: 0,
        user_liked: false
      };
      posts.unshift(newPost);
      renderAllPosts();
      document.getElementById('no-more').style.display = 'none';
    } else {
      // Fallback: full reload
      page = 1;
      posts = [];
      hasMore = true;
      document.getElementById('no-more').style.display = 'none';
      await loadPosts();
    }

  } catch (err) {
    console.error('Failed to submit post:', err);
    errorEl.textContent = '网络错误，请重试';
    errorEl.style.display = 'block';
    submitBtn.disabled = false;
    submitBtn.textContent = '发布';
  }
}

// ===== Helpers =====
// ===== User Status Check =====
async function checkUserStatus() {
  const banner = document.getElementById("suspended-banner");
  if (!banner) return;
  try {
    const res = await fetch("/api/user/status", { headers: authHeaders() });
    if (!res.ok) { banner.style.display = "none"; return; }
    const data = await res.json();
    if (data.suspended) {
      banner.style.display = "";
    } else {
      banner.style.display = "none";
    }
  } catch {
    banner.style.display = "none";
  }
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'Z');
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast' + (type ? ` ${type}` : '');
  toast.style.display = 'block';
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.style.display = 'none';
  }, 2500);
}

function showEmptyState() {
  document.getElementById('post-list').innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">📝</div>
      <p class="empty-state-text">还没有帖子，来发第一条吧！</p>
    </div>
  `;
}

function setupCharCounter() {
  const textarea = document.getElementById('post-content');
  const counter = document.getElementById('char-count');
  textarea && textarea.addEventListener('input', () => {
    counter.textContent = textarea.value.length;
  });
}

function setupMediaPreview() {
  const input = document.getElementById('post-media');
  const preview = document.getElementById('media-preview');
  const docxInput = document.getElementById('post-docx');
  const docxPreview = document.getElementById('docx-preview');
  input && input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    if (files.length > 3) {
      showToast('最多上传 3 个文件', 'error');
      input.value = '';
      preview.style.display = 'none';
      preview.innerHTML = '';
      return;
    }
    if (files.length === 0) {
      preview.style.display = 'none';
      preview.innerHTML = '';
      return;
    }
    // [2026-08-04] 任务4: Show multiple previews (grid)
    preview.style.display = 'block';
    preview.innerHTML = files.map(f => {
      const url = URL.createObjectURL(f);
      const isVideo = f.type.startsWith('video/');
      return isVideo
        ? `<video src="${url}" controls style="max-height:160px;border-radius:8px;width:100%;object-fit:cover;"></video>`
        : `<img src="${url}" alt="预览" style="height:120px;width:120px;object-fit:cover;border-radius:8px;">`;
    }).join('');
  });
  // [2026-08-31] Word 文档选择预览
  docxInput && docxInput.addEventListener('change', () => {
    const f = docxInput.files && docxInput.files[0];
    if (f) {
      if (!/\.docx$/i.test(f.name)) {
        showToast('仅支持 .docx 格式（防宏病毒，不支持 .doc/.docm）', 'error');
        docxInput.value = '';
        docxPreview.style.display = 'none';
        return;
      }
      if (f.size > 10 * 1024 * 1024) {
        showToast('Word 文档不能超过 10MB', 'error');
        docxInput.value = '';
        docxPreview.style.display = 'none';
        return;
      }
      docxPreview.style.display = 'flex';
      docxPreview.innerHTML = `<span>📄</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.name)}</span><span style="color:var(--text-muted);font-size:0.78rem;">${(f.size/1024).toFixed(0)} KB</span><span onclick="document.getElementById('post-docx').value='';this.parentElement.style.display='none';" style="cursor:pointer;color:var(--danger);flex-shrink:0;">✕</span>`;
    } else {
      docxPreview.style.display = 'none';
      docxPreview.innerHTML = '';
    }
  });
}

// ===== Infinite Scroll (IntersectionObserver) =====
let scrollObserver = null;

function setupScrollObserver() {
  // Disconnect previous observer if any
  if (scrollObserver) {
    scrollObserver.disconnect();
  }

  const sentinel = document.getElementById('scroll-sentinel');
  if (!sentinel) return;

  scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && hasMore && !loading) {
        loadPosts();
      }
    });
  }, {
    rootMargin: '200px',  // Trigger when within 200px of viewport
    threshold: 0
  });

  scrollObserver.observe(sentinel);
}
