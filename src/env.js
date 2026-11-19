/**
 * env.js —— 环境探测与基础工具
 *
 * 设计原则：
 * 1. 所有"能力探测"都必须 try/catch，探测失败不能被调用方感知，只能返回 false。
 * 2. 所有可能阻塞的探测（如 indexedDB.open）必须带超时，否则隐私模式下页面初始化会卡死。
 * 3. 工具函数一律不做抛错，输入异常时回退到字符串化，保证采集主流程不中断。
 */

/** 空函数，用于打平可选回调 */
export const noop = () => {};

/**
 * 探测 IndexedDB 是否"真的"可用。
 *
 * 陷阱说明（这是本 SDK 里最容易踩的一个）：
 * - Safari 无痕/隐私模式下 `indexedDB.open()` 会直接抛 SecurityError；
 * - 部分浏览器在存储被策略禁用时，open 请求会永远不回调（既不 success 也不 error）；
 * - 仅判断 `'indexedDB' in window` 是不够的，必须实际打开一个测试库。
 *
 * 因此这里做了三件事：真实打开测试库、超时兜底、用完立即删除避免污染用户环境。
 *
 * @param {number} timeout 超时毫秒数，超过即判定不可用
 * @returns {Promise<boolean>}
 */
export function probeIndexedDB(timeout = 2000) {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(false);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeout);

    try {
      const req = indexedDB.open('__diag_probe__', 1);
      req.onupgradeneeded = () => {};
      req.onsuccess = () => {
        clearTimeout(timer);
        const db = req.result;
        try { db.close(); } catch (e) {}
        // 立刻清除测试库，避免在客户环境里留下垃圾数据
        try { indexedDB.deleteDatabase('__diag_probe__'); } catch (e) {}
        finish(true);
      };
      req.onerror = () => { clearTimeout(timer); finish(false); };
      req.onblocked = () => { clearTimeout(timer); finish(false); };
    } catch (e) {
      clearTimeout(timer);
      finish(false);
    }
  });
}

/**
 * 探测 localStorage 可写。
 *
 * 陷阱：无痕模式下 localStorage 存在但 setItem 会抛 QuotaExceededError，
 * 所以必须真实写一次再删掉，不能只看 `typeof localStorage`。
 */
export function probeLocalStorage() {
  try {
    const k = '__diag_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 读取存储配额，用于提前降级而不是等 QuotaExceededError。
 * 不支持时返回 null，调用方应按"未知"处理。
 */
export async function readEstimate() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota, ratio: quota ? usage / quota : 0 };
  } catch (e) {
    return null;
  }
}

/**
 * 申请持久化存储。
 *
 * 陷阱：浏览器在磁盘压力下会清理"best-effort"类型的存储，IndexedDB 默认就是这一类。
 * 调用 persist() 后通常会被提升为 persistent，显著降低被清掉的概率。
 * 注意：Chrome 可能直接返回 true，Firefox 会弹权限框，Safari 支持有限——无论结果如何都不要影响主流程。
 */
export async function ensurePersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch (e) {
    return false;
  }
}

/**
 * FNV-1a 32 位哈希（同步、无依赖）。
 *
 * 为什么不用 crypto.subtle.digest：它是异步的，而指纹计算发生在错误回调里，
 * 异步化会让聚合窗口出现竞态（同一错误可能被重复入库）。
 * 错误指纹对碰撞的容忍度尚可，再用双种子拼成 64 位降低碰撞概率。
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 乘以 FNV 质数并保持 32 位无符号
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 生成错误指纹。
 *
 * 关键点：指纹里必须包含 release 和"归一化后的 message"，
 * 否则：
 * - 不含 release → 升级后新旧错误混在一起，无法判断是哪个版本引入的；
 * - 不做数字归一化 → 同一错误因为 ID/行号不同被拆成几百条记录，容量瞬间打爆。
 *
 * @param {object} p
 * @param {string} p.type
 * @param {string} p.message
 * @param {string} [p.stack]
 * @param {string} p.release
 * @returns {string}
 */
export function fingerprint(p) {
  const normalize = (s) =>
    String(s || '')
      // 数字、UUID、十六进制 id 统一成占位符，避免同一错误被无限拆分
      .replace(/\b0x[0-9a-f]+\b/gi, '0xN')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
      .replace(/\d{4,}/g, 'N')
      .replace(/\s+/g, ' ')
      .trim();

  // 只取栈的前 3 帧：更深的帧往往是第三方库内部实现，会把本质相同的错误拆开
  const topFrames = String(p.stack || '')
    .split('\n')
    .slice(0, 4)
    .map((l) => normalize(l))
    .join('|');

  const seed = `${p.type}::${normalize(p.message)}::${topFrames}::${p.release}`;
  return `${fnv1a(seed)}${fnv1a('salt' + seed)}`;
}

/** 生成随机 ID（不用 crypto.randomUUID，是为了兼容老旧国产双核浏览器） */
export function uid(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 脱敏。
 *
 * 私有化交付时，客户安全部门第一件事就是审这个函数，所以：
 * - 手机号、邮箱、身份证、token/密码参数必须处理；
 * - 只做"值替换"，不改变句子结构，避免破坏排查价值。
 */
export function mask(text) {
  if (typeof text !== 'string') return text;
  return text
    // 手机号保留前后各 3/2 位
    .replace(/\b1[3-9]\d{9}\b/g, (m) => `${m.slice(0, 3)}****${m.slice(-2)}`)
    // 邮箱保留前两位
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => {
      const at = m.indexOf('@');
      return `${m.slice(0, Math.min(2, at))}***${m.slice(at)}`;
    })
    // 身份证（15/18 位）
    .replace(/\b\d{17}[\dXx]\b/g, '***************X')
    .replace(/\b\d{15}\b/g, '***************')
    // URL / JSON 里的敏感参数
    .replace(/((?:token|access_token|authorization|password|pwd|secret|ticket|sessionid|sid)=)[^&\s,}"]+/gi, '$1***');
}

/**
 * 去掉 URL 的 query 值，只保留参数名。
 *
 * 目的：既能定位是哪个接口，又不把 token、手机号、订单号带出来。
 * 例：/api/order?orderId=123&token=abc → /api/order?orderId&token
 */
export function stripQuery(url) {
  try {
    const u = new URL(String(url), location.origin);
    const keys = Array.from(u.searchParams.keys());
    return `${u.origin}${u.pathname}${keys.length ? '?' + keys.join('&') : ''}`;
  } catch (e) {
    return String(url || '').split('?')[0];
  }
}

/** 采集一次运行环境快照，随事件上报，用于还原"在什么环境下卡住了" */
export function getContext() {
  const out = {};
  try {
    out.ua = navigator.userAgent;
    out.lang = navigator.language;
    out.net = navigator.onLine ? 'online' : 'offline';
    out.dpr = window.devicePixelRatio || 1;
    out.screen = `${screen.width}x${screen.height}`;
    out.vw = window.innerWidth;
  } catch (e) {}
  return out;
}

/**
 * 统一的安全执行包装。
 *
 * SDK 自身任何一步抛错，都不能让宿主页面崩溃——监控代码搞挂业务页面，
 * 比不监控严重得多。所有对外回调、钩子入口都应该走这里。
 */
export function safe(fn, onError) {
  try {
    return fn();
  } catch (e) {
    try { onError && onError(e); } catch (_) {}
    return undefined;
  }
}

/** 截断字符串，控制单条事件体积（IndexedDB 容量有限，且 sendBeacon 有 64KB 限制） */
export function clampStr(str, max = 3000) {
  const s = String(str == null ? '' : str);
  return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

/**
 * 文件名归一化。
 *
 * 为什么必须做这一步：同一个 bundle 在不同客户环境里可能来自
 *   http://10.0.0.1/static/js/main.abc123.js
 *   https://cdn.corp.com/app/2.3.1/main.abc123.js?v=1
 * 如果不归一化，symbolicate 服务按"完整 URL"去匹配 sourcemap 永远匹配不到。
 *
 * 只保留 pathname，顺带去掉 query 和 fragment。
 */
export function normalizeFile(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url), location.origin);
    return u.pathname;
  } catch (e) {
    return String(url).split('?')[0].split('#')[0];
  }
}

/**
 * 调用栈归一化：把每一帧里的 origin 去掉，统一成 pathname。
 *
 * 只处理 http/https 绝对地址；`webpack://`、`node:` 等其他协议原样保留，
 * 因为 symbolicate 侧通常按文件名匹配，不需要这些前缀。
 */
export function normalizeStack(stack) {
  if (!stack) return '';
  return String(stack)
    .split('\n')
    .map((line) => line.replace(/https?:\/\/[^\s/)]+/g, ''))
    .join('\n');
}

/**
 * 取当前调用栈，最多保留 frames 帧。
 *
 * 为什么要限制帧数：接口请求的调用栈往往深达几十帧，其中大部分是框架内部
 * （react-dom、axios 自己的拦截器），真正有用的是最上面 5 帧业务代码。
 * 截断既省体积，也让后续 symbolicate 更快。
 */
export function captureStack(frames = 6) {
  try {
    const raw = new Error('diag-trace').stack || '';
    const lines = raw.split('\n');
    // 第一行是 "Error: diag-trace"，对定位无意义，丢弃
    return normalizeStack(lines.slice(1, frames + 1).join('\n'));
  } catch (e) {
    return '';
  }
}
