/**
 * probe.js —— 可用性探针
 *
 * 这里放两个"全埋点思维完全覆盖不到"的能力：
 *   1. 白屏探针：页面骨架没渲染出来，用户其实什么都做不了；
 *   2. 交互事务：用户点了关键按钮，但 N 秒内没有任何预期结果。
 *
 * 这两个探针的共同点是：都需要"人工声明一个预期"，SDK 只负责等待和超时判定。
 * 这也是纯自动全埋点无法替代的部分。
 */

import { safe } from './env.js';

/**
 * 白屏探针。
 *
 * 判定方式：配置若干"首屏必须存在的关键节点"选择器，
 * 在 timeout 内一个都没出现 → 判白屏。
 *
 * 陷阱与取舍：
 * - 绝不能用 body 的高度/文本长度判断，很多正常页面首屏也是空的；
 * - 选择器必须是"业务稳定存在"的节点，配错了会持续误报，所以要求至少 2 个做"或"关系；
 * - 只在首次进入时检测，路由级白屏成本高（每次路由都挂轮询会明显耗电），
 *   如果客户有强需求，可以传 everyRoute: true 打开；
 * - 检测到之后必须立刻停止轮询，否则一个白屏页面会反复触发。
 *
 * @param {object} opts
 * @param {string[]} opts.selectors 关键节点选择器列表，任意一个出现即视为渲染成功
 * @param {number} [opts.timeout=10000] 超时毫秒
 * @param {boolean} [opts.everyRoute=false] 是否每次路由变化都重新检测
 * @param {(detail: object) => void} opts.onWhiteScreen
 * @returns {{ stop: Function, reset: Function }}
 */
export function startWhiteScreenProbe(opts) {
  const selectors = opts.selectors || [];
  const timeout = opts.timeout || 10000;
  const interval = opts.interval || 1000;
  // 默认要求"存在且可见"：只看 querySelector 会漏掉最常见的一类白屏——
  // 节点渲染出来了但高度为 0 / display:none，用户看到的就是空白页。
  const requireVisible = opts.requireVisible !== false;

  let timer = null;
  let startedAt = 0;
  let stopped = false;
  let reported = false;

  const exists = () => {
    // 任一关键节点"存在且可见"，就认为页面能用了
    for (let i = 0; i < selectors.length; i++) {
      try {
        const el = document.querySelector(selectors[i]);
        if (!el) continue;
        if (!requireVisible) return true;
        // getClientRects 比 offsetWidth 更可靠：对 inline 元素、被 transform 缩放的元素都适用
        const rects = el.getClientRects ? el.getClientRects() : null;
        if (rects && rects.length > 0) return true;
        if (!rects && (el.offsetWidth > 0 || el.offsetHeight > 0)) return true;
      } catch (e) {
        // 选择器语法错误不能让整页崩，直接跳过
      }
    }
    return false;
  };

  const tick = () => {
    if (stopped) return;
    if (exists()) {
      stop();
      return;
    }
    if (Date.now() - startedAt >= timeout) {
      if (!reported) {
        reported = true;
        safe(() => {
          opts.onWhiteScreen({
            type: 'white_screen',
            message: `首屏 ${timeout}ms 内关键节点未渲染`,
            level: 'block',
            extra: {
              selectors,
              waited: Date.now() - startedAt,
              readyState: document.readyState,
              // 记录 DOM 里实际有多少节点，帮助判断是"没渲染"还是"渲染了但没这个选择器"
              domNodes: document.querySelectorAll('*').length,
            },
          });
        });
      }
      stop();
      return;
    }
    timer = setTimeout(tick, interval);
  };

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** reset：路由切换后重新开始计时（everyRoute 模式使用） */
  function reset() {
    stop();
    stopped = false;
    reported = false;
    startedAt = Date.now();
    timer = setTimeout(tick, interval);
  }

  startedAt = Date.now();
  // 如果已经加载完成，先立刻判断一次，避免白屏页面还要多等一个 interval
  if (document.readyState === 'complete') {
    tick();
  } else {
    timer = setTimeout(tick, interval);
  }

  return { stop, reset };
}

/**
 * 交互事务追踪器。
 *
 * 模型：一次"关键点击"开启一个事务，事务有一个超时窗口；
 * 在窗口内收到任一"成功信号"（路由跳转 / 指定接口成功 / 手动 settle）就结算成功；
 * 超时仍未结算 → 判定为"点了没反应"。
 *
 * 声明方式（业务侧零代码成本，只加属性）：
 *   <button data-critical="login"
 *           data-expect-route="/home"
 *           data-expect-api="/api/login">登录</button>
 *
 * 可靠性注意：
 * - e.target 可能是文本节点/非 Element，closest 不能无条件调用；
 * - 事务结束后必须 clearTimeout，否则页面上点几十次会积累几十个定时器；
 * - 页面隐藏/卸载时统一清理，避免内存泄漏；
 * - 同一 key 短时间内重复点击要合并，否则会因"人手抖"产生大量误报。
 */
export class InteractionTracker {
  constructor(opts = {}) {
    this.timeout = opts.timeout || 5000;
    this.onBlocked = opts.onBlocked || (() => {});
    this.log = opts.log || (() => {});
    this.pending = new Map(); // id -> tx
    this.lastFire = new Map(); // key -> ts，用于去重
    this._bound = null;
  }

  start() {
    if (this._bound) return;
    this._bound = (e) => safe(() => this._onClick(e));
    // 捕获阶段：即使业务代码 stopPropagation 也能拦到
    document.addEventListener('click', this._bound, true);
  }

  stop() {
    if (this._bound) {
      document.removeEventListener('click', this._bound, true);
      this._bound = null;
    }
    this._clearAll();
  }

  _onClick(e) {
    const target = e.target;
    // 文本节点、SVG 内部节点都可能没有 closest
    if (!target || typeof target.closest !== 'function') return;

    const el = target.closest('[data-critical]');
    if (!el) return;

    const key = el.getAttribute('data-critical');
    if (!key) return;

    // 去重：同一 key 1 秒内重复点击只认第一次，避免误报
    const now = Date.now();
    const last = this.lastFire.get(key) || 0;
    if (now - last < 1000) return;
    this.lastFire.set(key, now);

    const tx = {
      id: `${key}-${now}`,
      key,
      startAt: now,
      expectRoute: el.getAttribute('data-expect-route') || '',
      expectApi: el.getAttribute('data-expect-api') || '',
      timer: null,
    };

    tx.timer = setTimeout(() => {
      if (!this.pending.has(tx.id)) return;
      this.pending.delete(tx.id);
      safe(() => {
        this.onBlocked({
          type: 'blocked_interaction',
          message: `关键操作「${key}」在 ${this.timeout}ms 内无预期结果`,
          level: 'block',
          extra: {
            key,
            expectRoute: tx.expectRoute,
            expectApi: tx.expectApi,
            waited: Date.now() - tx.startAt,
          },
        });
      });
    }, this.timeout);

    this.pending.set(tx.id, tx);
    // 兜底：Map 不能无限增长，超过 50 个未结算事务时清掉最旧的
    if (this.pending.size > 50) {
      const first = this.pending.keys().next().value;
      this._settle(first, true);
    }
  }

  /** 成功信号：路由变化。匹配上有 expectRoute 的事务即结算 */
  settleByRoute(route) {
    if (!route) return;
    this.pending.forEach((tx, id) => {
      if (tx.expectRoute && route.indexOf(tx.expectRoute) !== -1) this._settle(id);
    });
  }

  /**
   * 成功信号：接口成功。
   * 只有当事务声明了 expectApi 且当前 URL 命中，才结算；
   * 未声明 expectApi 的事务不会被"任意接口成功"误结算。
   */
  settleByApi(url, ok) {
    if (!ok || !url) return;
    this.pending.forEach((tx, id) => {
      if (tx.expectApi && url.indexOf(tx.expectApi) !== -1) this._settle(id);
    });
  }

  /** 手动结算：业务在拿到明确成功回调（如 toast 成功、弹窗出现）时调用 */
  settleManual(key) {
    this.pending.forEach((tx, id) => {
      if (tx.key === key) this._settle(id);
    });
  }

  _settle(id) {
    const tx = this.pending.get(id);
    if (!tx) return;
    this.pending.delete(id);
    if (tx.timer) clearTimeout(tx.timer);
  }

  _clearAll() {
    this.pending.forEach((tx) => tx.timer && clearTimeout(tx.timer));
    this.pending.clear();
  }
}
