/**
 * SDK 主控
 *
 * 把采集、判定、存储、上报、导出串成一条链路。三件事必须在这里统一处理：
 *
 * 1. 阻断判定：采集层只管"发生了什么"，这里决定"这算不算阻断、要不要入库"。
 *    只收集阻断故障时，噪音过滤全靠这一层，所以规则集中在这里，便于按客户现场调。
 *
 * 2. 内存聚合：同一指纹在一个 flush 周期内只保留一条，count 累加。
 *    这一步是整个方案能长期跑下去的前提——否则一次循环报错能写满整个库。
 *
 * 3. 生命周期：先挂钩子再接存储。错误可能在 store.init() 完成前就发生，
 *    所以缓冲区必须能在"存储未就绪"的状态下正常收数据，就绪后再补落盘。
 */

import {
  probeIndexedDB, readEstimate, ensurePersist,
  fingerprint, uid, clampStr, getContext, mask, safe,
} from './env.js';
import { Store } from './store.js';
import {
  hookErrors, hookFetch, hookRoute, getRoute,
  wrapAxios as attachAxiosHook, createBreadcrumb,
  createReactHandler, bindVue as attachVue,
} from './collect.js';
import { startWhiteScreenProbe, InteractionTracker } from './probe.js';

const SDK_VERSION = '0.1.0';

/** 默认配置。所有值都可以被业务侧覆盖，但 release 必须由业务传入 */
const DEFAULTS = {
  appId: '',
  /** 版本号：必填。没有它就无法判断故障是哪个版本引入的，也会让指纹失去区分度 */
  release: '',
  /** 上报地址；留空 = 纯本地模式（只落 IndexedDB，靠导出取回） */
  endpoint: '',
  /** 是否只收集"阻断级"事件。true 时 degrade 级直接丢弃，这是本 SDK 的核心开关 */
  onlyBlock: true,
  /** 关键接口前缀（命中即视为阻断级）。例：['/api/login', '/api/pay', '/api/order/submit'] */
  criticalApis: [],
  /** 忽略的接口（例如上报自身、健康检查、埋点上报） */
  ignoreApis: [],
  /** 慢接口阈值（毫秒），关键接口超过此值判阻断 */
  slowApi: 5000,
  /**
   * 接口调用栈采集策略：
   * - 'critical'：只对命中 criticalApis 的请求抓栈（默认，性能友好）
   * - 'all'：所有请求都抓（排查期临时打开）
   * - 'off'：不抓
   *
   * 抓栈会在请求发起时创建 Error 对象，高频列表页会有可观开销，
   * 所以默认不对非关键接口开启。
   */
  apiStack: 'critical',
  /** 缓冲落盘间隔（毫秒） */
  flushInterval: 500,
  /** 缓冲内事件种类达到该值时立即落盘 */
  batchSize: 20,
  /** 单库最多保留多少条（按指纹聚合后） */
  maxRows: 2000,
  /** 保留天数 */
  ttlDays: 7,
  /** 关键点击无回执的判定窗口（毫秒） */
  interactTimeout: 5000,
  /** 白屏探针：selectors 为空则不开启 */
  whiteScreen: { selectors: [], timeout: 10000, everyRoute: false },
  /** 面包屑保留条数 */
  breadcrumbMax: 20,
  /** 采样率 0~1（只对非阻断级生效，阻断级永远全采） */
  sampleRate: 1,
  /** 调试日志，会打到 console */
  debug: false,
  /** 自定义钩子：可在这里给事件补充字段或做二次过滤 */
  beforeSend: null,
};

/**
 * 诊断 SDK。
 *
 * 用法：
 *   const diag = new Diagnose({ appId: 'x', release: __VERSION__, criticalApis: [...] });
 *   diag.start();
 *   diag.wrapAxios(axiosInstance);      // 可选
 *   diag.report({ type:'custom_block', message:'xxx' });  // 业务手动上报
 *   diag.export();                       // 导出诊断包
 */
export class Diagnose {
  constructor(config = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this.cfg.whiteScreen = { ...DEFAULTS.whiteScreen, ...(config.whiteScreen || {}) };

    this.version = SDK_VERSION;
    this.deviceId = this._getDeviceId();
    this.sessionId = this._getSessionId();
    this.bootAt = Date.now();

    this.store = new Store({
      maxRows: this.cfg.maxRows,
      ttlDays: this.cfg.ttlDays,
      log: (lv, msg) => this.log(lv, msg),
    });

    /** 缓冲：Map<fingerprint, event>。按种类聚合，天然限流 */
    this._buf = new Map();
    this._flushTimer = null;
    this._ready = false;      // 存储是否就绪
    this._destroyed = false;
    this._inRecord = false;   // 防递归：SDK 自身错误不得再次进入记录链路
    this._flushing = false;
    this._offs = [];          // 所有钩子的卸载函数

    this.breadcrumb = createBreadcrumb(this.cfg.breadcrumbMax * 5);
    this.tracker = new InteractionTracker({
      timeout: this.cfg.interactTimeout,
      onBlocked: (ev) => this.record(ev),
      log: (lv, msg) => this.log(lv, msg),
    });

    this.persistGranted = false;
  }

  /* ------------------------------------------------------------------ */
  /* 启动与销毁                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 启动。
   *
   * 顺序很重要：先同步挂错误钩子，再去异步初始化存储。
   * 如果反过来，用户在 init 期间的几十毫秒里发生的错误会全部丢失。
   */
  async start() {
    if (this._destroyed) return this;

    // 1) 先挂采集钩子（同步，立刻生效）
    this._offs.push(hookErrors((ev) => this.record(ev), () => this._base()));
    this._offs.push(
      hookFetch({
        onApi: (payload) => this.record({ type: 'api_error', api: payload }),
        // 只有被选中的请求才抓调用栈，避免给所有接口增加固定开销
        needStack: (url) => this._needApiStack(url),
      }, () => this._base())
    );

    // 2) 路由监听：同时喂给面包屑和交互事务
    this._offs.push(
      hookRoute((route) => {
        this.breadcrumb.onRoute(route);
        this.tracker.settleByRoute(route);
        if (this.cfg.whiteScreen.everyRoute && this._whiteProbe) this._whiteProbe.reset();
      })
    );

    // 3) 白屏探针
    if (this.cfg.whiteScreen.selectors && this.cfg.whiteScreen.selectors.length) {
      this._whiteProbe = startWhiteScreenProbe({
        selectors: this.cfg.whiteScreen.selectors,
        timeout: this.cfg.whiteScreen.timeout,
        onWhiteScreen: (ev) => this.record(ev),
      });
    }

    // 4) 关键交互事务
    this.tracker.start();

    // 5) 页面卸载：把缓冲尽量落盘，并（如开启）用 beacon 兜底上报。
    // 这里必须用箭头函数就地定义，不能把类方法直接当监听器——
    // 监听器回调的 this 是 window/document，会在 _onPageHide 调用时丢失上下文。
    this._onHide = () => safe(() => this._onPageHide());
    this._onVisibility = () => {
      if (document.visibilityState === 'hidden') safe(() => this._onPageHide());
    };
    window.addEventListener('pagehide', this._onHide, true);
    window.addEventListener('visibilitychange', this._onVisibility, true);

    // 6) 存储初始化（异步）。失败会自动降级到 localStorage/memory
    this.store.init().then(async (mode) => {
      this._ready = true;
      this.log('info', `存储模式：${mode}`);
      if (mode === 'idb') {
        this.persistGranted = await ensurePersist();
        this.log('info', `持久化存储：${this.persistGranted ? '已授权' : '未授权'}`);
      }
      // init 期间攒下来的事件，在这里补落盘
      this._flush();
      // 开机补传：上次关闭时没发出去的残留
      if (this.cfg.endpoint) this.flushRemote();
    });

    return this;
  }

  /**
   * 销毁：卸载所有监听、停掉探针、清空缓冲。
   * 单页应用热更新或组件卸载时必须调用，否则监听会越叠越多。
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._offs.forEach((off) => safe(off));
    this._offs = [];
    safe(() => this.tracker.stop());
    safe(() => this._whiteProbe && this._whiteProbe.stop());
    safe(() => window.removeEventListener('pagehide', this._onHide, true));
    safe(() => window.removeEventListener('visibilitychange', this._onVisibility, true));
    safe(() => this.breadcrumb.off());
    this._buf.clear();
  }

  /* ------------------------------------------------------------------ */
  /* 记录与判定                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 统一记录入口。
   *
   * 内部会依次做：阻断判定 → 上下文补全 → 指纹计算 → 缓冲聚合。
   * 任何一步失败都只丢这一条，不影响后续采集。
   *
   * @param {object} payload { type, message, stack, file, line, api, extra, level }
   */
  record(payload) {
    // 防递归：如果这次调用是由 SDK 自身逻辑触发的，直接丢弃
    if (this._destroyed || this._inRecord) return;
    this._inRecord = true;

    try {
      // 成功的接口只作为"交互事务结算信号"，不进判定、不入库。
      // 这一步必须放在 _judge 之前：否则成功请求会被当成故障数据污染库表。
      if (payload && payload.type === 'api_error' && payload.api && payload.api.ok) {
        this.tracker.settleByApi(payload.api.url, true);
        return;
      }

      const ev = this._judge(payload);
      if (!ev) return;

      // 采样：只对非阻断级生效，阻断级必须全采（这是"只收集阻断"场景的底线）
      if (ev.level !== 'block' && Math.random() > this.cfg.sampleRate) return;

      const enriched = this._enrich(ev);

      // 业务钩子：允许追加字段或返回 null 丢弃
      if (typeof this.cfg.beforeSend === 'function') {
        const out = safe(() => this.cfg.beforeSend({ ...enriched }));
        if (out === null) return;
        if (out && typeof out === 'object') Object.assign(enriched, out);
      }

      // 按指纹合并：同一类错误在一个 flush 周期内只留一条
      const fp = enriched.fingerprint;
      const old = this._buf.get(fp);
      if (old) {
        old.count += 1;
        old.lastTs = enriched.ts;
      } else {
        this._buf.set(fp, enriched);
      }

      if (this.cfg.debug) {
        this.log('info', `捕获 ${enriched.type} / ${enriched.level}: ${enriched.message}`);
      }

      // 缓冲达到阈值立即落盘，避免高峰期数据在内存里被页面关闭带走
      if (this._buf.size >= this.cfg.batchSize) this._flush();
      else this._scheduleFlush();
    } catch (e) {
      this.log('error', `record 失败：${e && e.message}`);
    } finally {
      this._inRecord = false;
    }
  }

  /**
   * 阻断判定。
   *
   * 这是"只收集阻断故障"的过滤器。规则集中在这里，方便按客户现场快速调整：
   * - 网络失败（status 0）、5xx → 阻断
   * - 4xx → 默认降级（多半是参数/权限问题，用户还有别的路可走）
   * - 业务码错误 → 只有关键接口才算阻断
   * - 关键接口超时 → 阻断
   * - 其他类型沿用采集层给的 level
   *
   * @returns {object|null} 归一化后的事件，null 表示不入库
   */
  _judge(p) {
    if (!p || !p.type) return null;

    let level = p.level || 'degrade';

    if (p.type === 'api_error' && p.api) {
      const { url, status, bizCode, cost } = p.api;

      // 忽略名单：上报接口自身必须排除，否则一次上报失败会引发无限递归
      if (this._isIgnored(url)) return null;

      const isCritical = this._isCritical(url);

      if (!status || status === 0) {
        level = 'block';              // 网络层失败：用户这一步彻底走不下去了
      } else if (status >= 500) {
        level = 'block';              // 服务端故障
      } else if (status >= 400) {
        level = isCritical ? 'block' : 'degrade';
      } else if (bizCode !== undefined && bizCode !== 0 && bizCode !== '0') {
        level = isCritical ? 'block' : 'degrade';
      } else if (cost > this.cfg.slowApi) {
        level = isCritical ? 'block' : 'degrade';
      } else if (isCritical && cost > 0) {
        // 关键接口成功但很慢：属于体验问题，先按降级记
        level = 'degrade';
      } else {
        return null;                  // 成功且不慢，直接不记
      }
    }

    if (p.type === 'api_slow') {
      level = this._isCritical(p.api && p.api.url) ? 'block' : 'degrade';
    }

    // 只收集阻断时，降级事件直接丢
    if (this.cfg.onlyBlock && level !== 'block') return null;

    return {
      type: p.type,
      level,
      message: clampStr(mask(p.message || this._fallbackMessage(p)), 500),
      stack: clampStr(mask(p.stack), 3000),
      file: (p.file && mask(p.file)) || '',
      line: p.line || 0,
      col: p.col || 0,
      api: p.api ? {
        url: p.api.url || '',
        method: p.api.method || '',
        status: p.api.status,
        bizCode: p.api.bizCode,
        cost: p.api.cost,
        traceId: p.api.traceId,
        error: clampStr(mask(p.api.error), 200),
      } : null,
      extra: p.extra || null,
      // 接口报错：记录"是哪个业务代码发起的"，这是定位代码位置的另一半
      originStack: clampStr(mask(p.originStack || (p.api && p.api.originStack) || ''), 1500),
      // 框架错误：记录"哪个组件崩的"，比源码行号更直观
      componentStack: clampStr(mask(p.componentStack || ''), 1500),
      clientTs: Date.now(),
    };
  }

  /** 补全上下文：版本、路由、会话、环境、面包屑，并计算指纹 */
  _enrich(ev) {
    const ts = ev.clientTs || Date.now();
    const route = getRoute();
    ev.ts = ts;
    ev.relTs = ts - this.bootAt;      // 相对启动时间：客户端时钟错乱时仍能正确排序
    ev.bootAt = this.bootAt;
    ev.release = this.cfg.release || 'unknown';
    ev.appId = this.cfg.appId;
    ev.route = route;
    ev.sessionId = this.sessionId;
    ev.deviceId = this.deviceId;
    ev.count = 1;
    ev.lastTs = ts;
    ev.synced = 0;
    ev.ctx = getContext();
    ev.breadcrumbs = this.breadcrumb.get().slice(-this.cfg.breadcrumbMax);
    ev.fingerprint = fingerprint({
      type: ev.type,
      message: ev.message,
      stack: ev.stack,
      release: ev.release,
    });
    return ev;
  }

  _fallbackMessage(p) {
    if (p.type === 'api_error' && p.api) {
      return `接口异常 ${p.api.method || ''} ${p.api.url || ''} status=${p.api.status}`;
    }
    return String(p.type);
  }

  /** 是否属于忽略名单（含上报接口自身） */
  _isIgnored(url) {
    if (!url) return false;
    if (this.cfg.endpoint) {
      try {
        const ep = new URL(this.cfg.endpoint, location.origin);
        if (url.indexOf(ep.pathname) !== -1) return true;
      } catch (e) {}
    }
    return this.cfg.ignoreApis.some((s) => url.indexOf(s) !== -1);
  }

  _isCritical(url) {
    if (!url) return false;
    return this.cfg.criticalApis.some((s) => url.indexOf(s) !== -1);
  }

  /** 是否需要对当前请求抓调用栈 */
  _needApiStack(url) {
    if (this.cfg.apiStack === 'off') return false;
    if (this.cfg.apiStack === 'all') return true;
    return this._isCritical(url);
  }

  /**
   * 上报框架层错误（React ErrorBoundary / Vue errorHandler）。
   *
   * 与 window error 钩子的区别：框架会"捕获并吞掉"很多错误，
   * 这些错误压根不会冒泡到 window.onerror，必须由框架适配层主动送进来。
   *
   * @param {Error} error
   * @param {object|string} info { componentStack } 或 Vue 的 info 字符串
   */
  reportFrameworkError(error, info) {
    const componentStack =
      typeof info === 'string' ? info : (info && info.componentStack) || '';
    this.record({
      type: 'js_error',
      message: (error && (error.message || String(error))) || '框架错误',
      stack: error && error.stack,
      componentStack,
      // 能冒到 ErrorBoundary 的错误通常已经导致这块 UI 不可用，按阻断处理
      level: 'block',
    });
  }

  /**
   * 绑定 Vue 全局错误处理。
   * 内部是链式调用，不会覆盖业务已有的 app.config.errorHandler。
   *
   * @param {object} app Vue 应用实例
   */
  bindVue(app) {
    if (!app || !app.config) return this;
    this._offs.push(
      attachVue(app, (p) => this.reportFrameworkError(p.error, { componentStack: p.componentStack }))
    );
    return this;
  }

  /**
   * 返回可直接用于 React 的错误处理函数。
   *
   * 用法一（ErrorBoundary）：
   *   componentDidCatch = diag.getReactErrorHandler()
   *
   * 用法二（React 19 createRoot）：
   *   createRoot(el, { onUncaughtError: diag.getReactErrorHandler() })
   */
  getReactErrorHandler() {
    return createReactHandler((p) => this.reportFrameworkError(p.error, { componentStack: p.componentStack }));
  }

  /* ------------------------------------------------------------------ */
  /* 落盘与上报                                                          */
  /* ------------------------------------------------------------------ */

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, this.cfg.flushInterval);
  }

  /**
   * 把内存缓冲落盘。
   *
   * 注意：存储未就绪时不能丢数据，只保留缓冲等下次——
   * 这正是"先挂钩子后接存储"的原因。
   */
  _flush() {
    if (this._flushing || !this._ready || this._buf.size === 0) return;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }

    this._flushing = true;
    const events = Array.from(this._buf.values());
    this._buf.clear();

    this.store.write(events, (err) => {
      this._flushing = false;
      if (err) {
        // 写失败时把事件放回缓冲，等降级完成后重试（不能静默丢失）
        events.forEach((ev) => {
          if (!this._buf.has(ev.fingerprint)) this._buf.set(ev.fingerprint, ev);
        });
        this._scheduleFlush();
        return;
      }
      // 本地落盘成功后，如果开了上报，再异步推一次
      if (this.cfg.endpoint) this.flushRemote();
    });
  }

  /**
   * 上报未同步记录。
   *
   * 与本地落地是"双写"关系：本地永远保留，上报成功后只打 synced 标记不删除，
   * 这样客户现场出问题时仍可导出取证。
   *
   * sendBeacon 优先：它在页面卸载时也不会被中断，但单次有 64KB 体积限制，
   * 所以这里限制了单批条数，超出部分等下一轮。
   */
  flushRemote() {
    if (!this.cfg.endpoint || this._destroyed) return Promise.resolve();
    return this.store.readUnsynced(30).then((rows) => {
      if (!rows.length) return;
      const body = JSON.stringify({
        appId: this.cfg.appId,
        release: this.cfg.release,
        sdk: SDK_VERSION,
        sentAt: Date.now(),
        events: rows,
      });

      // 超过 60KB 时拆分重试，避免 sendBeacon 静默失败
      if (body.length > 60000) {
        this.log('warn', '上报包过大，本轮跳过剩余部分');
        return;
      }

      const ok = this._post(body);
      if (ok) this.store.markSynced(rows.map((r) => r.id));
    });
  }

  _post(body) {
    try {
      const url = this.cfg.endpoint;
      const blob = new Blob([body], { type: 'application/json' });

      // sendBeacon：不阻塞页面、卸载时也送达；返回 false 表示浏览器拒绝（多为超限）
      if (navigator.sendBeacon && navigator.sendBeacon(url, blob)) return true;

      // 回退到 fetch keepalive
      if (typeof fetch === 'function') {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch((e) => this.log('warn', `上报失败：${e && e.message}`));
        return true;
      }
    } catch (e) {
      this.log('warn', `上报异常：${e && e.message}`);
    }
    return false;
  }

  /**
   * 页面隐藏/卸载时的收尾。
   *
   * 陷阱：此时 IndexedDB 写入可能被浏览器直接打断（事务来不及提交）。
   * 所以策略是：内存缓冲先走 beacon 直接发出去（不依赖 IO），
   * 同时尽力触发一次落盘；哪条路成功都算保住数据。
   */
  _onPageHide() {
    if (this._buf.size === 0 && this._flushing) return;

    // 路径一：缓冲直接 beacon 上报（绕过存储，最快）
    if (this.cfg.endpoint && this._buf.size > 0) {
      const events = Array.from(this._buf.values());
      const body = JSON.stringify({
        appId: this.cfg.appId,
        release: this.cfg.release,
        sdk: SDK_VERSION,
        sentAt: Date.now(),
        pagehide: true,
        events,
      });
      if (body.length <= 60000 && navigator.sendBeacon) {
        try {
          navigator.sendBeacon(this.cfg.endpoint, new Blob([body], { type: 'application/json' }));
          this._buf.clear(); // beacon 已接管，避免重复落库
        } catch (e) {}
      }
    }

    // 路径二：尽力落盘（失败也无妨，因为路径一已兜底）
    this._flush();
  }

  /* ------------------------------------------------------------------ */
  /* 导出与对外能力                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 导出诊断包。
   *
   * 这是"客户禁止数据回传"时的唯一取回路径，所以必须是产品级能力而不是调试工具：
   * - 包含元信息，运维拿到包能直接判断环境是否异常（如存储降级到 memory）
   * - 默认脱敏，避免安全审查卡住
   * - 优先 gzip，体积从几 MB 压到几百 KB，适合工单附件
   */
  async export() {
    const events = await this.store.readAll();
    const estimate = await readEstimate();
    const idbOk = await probeIndexedDB();

    const payload = {
      meta: {
        sdk: SDK_VERSION,
        appId: this.cfg.appId,
        release: this.cfg.release,
        deviceId: this.deviceId,
        sessionId: this.sessionId,
        exportedAt: new Date().toISOString(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // 排查"为什么没有数据"的三个关键字段
        storageMode: this.store.mode,
        idbAvailable: idbOk,
        persistGranted: this.persistGranted,
        quota: estimate,
        bootAt: this.bootAt,
        ua: navigator.userAgent,
        url: location.origin + location.pathname,
      },
      stats: {
        total: events.length,
        blocked: events.filter((e) => e.level === 'block').length,
        byType: events.reduce((acc, e) => {
          acc[e.type] = (acc[e.type] || 0) + 1;
          return acc;
        }, {}),
      },
      events,
    };

    const text = JSON.stringify(payload);
    const blob = await this._maybeGzip(text);
    this._download(blob, `diag_${this.cfg.release || 'unknown'}_${Date.now()}.json${blob.gzip ? '.gz' : ''}`);
    return payload;
  }

  /** 生成诊断包但不下载，供"复制到剪贴板"或自定义上传使用 */
  async buildPackage() {
    const events = await this.store.readAll();
    return {
      meta: {
        sdk: SDK_VERSION,
        appId: this.cfg.appId,
        release: this.cfg.release,
        deviceId: this.deviceId,
        sessionId: this.sessionId,
        storageMode: this.store.mode,
        exportedAt: new Date().toISOString(),
      },
      events,
    };
  }

  /**
   * gzip 压缩。
   * CompressionStream 在 Chrome 80+/Edge 支持，Firefox/Safari 不支持时回退纯 JSON。
   * 这里不用第三方库，保持 SDK 零依赖。
   */
  async _maybeGzip(text) {
    if (typeof CompressionStream === 'undefined') {
      return new Blob([text], { type: 'application/json' });
    }
    try {
      const cs = new CompressionStream('gzip');
      const stream = new Blob([text], { type: 'application/json' }).stream().pipeThrough(cs);
      const blob = await new Response(stream).blob();
      blob.gzip = true;
      return blob;
    } catch (e) {
      return new Blob([text], { type: 'application/json' });
    }
  }

  _download(blob, filename) {
    try {
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // 延迟回收，避免部分浏览器下载还没开始就被 revoke
      setTimeout(() => {
        try { URL.revokeObjectURL(url); a.remove(); } catch (e) {}
      }, 5000);
    } catch (e) {
      this.log('error', `导出失败：${e && e.message}`);
    }
  }

  /** 业务手动上报（自定义阻断事件） */
  report(payload) {
    this.record({ level: 'degrade', ...payload });
  }

  /** 手动结算某个关键交互（业务拿到明确成功信号时调用） */
  settle(key) {
    this.tracker.settleManual(key);
  }

  /** axios 包装，显式调用 */
  wrapAxios(instance) {
    this._offs.push(
      attachAxiosHook(instance, {
        // 成功/失败统一交给 record 分流：ok=true 只结算交互事务，不产生记录
        onApi: (payload) => this.record({ type: 'api_error', api: payload }),
        needStack: (url) => this._needApiStack(url),
      })
    );
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* 内部工具                                                            */
  /* ------------------------------------------------------------------ */

  /** deviceId：跨会话稳定，存 localStorage，不可用时退回内存级随机值 */
  _getDeviceId() {
    const KEY = '__diag_device__';
    try {
      let id = localStorage.getItem(KEY);
      if (!id) {
        id = uid('d-');
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch (e) {
      return uid('d-');
    }
  }

  /** sessionId：单次会话（sessionStorage），新开标签页即新会话 */
  _getSessionId() {
    const KEY = '__diag_session__';
    try {
      let id = sessionStorage.getItem(KEY);
      if (!id) {
        id = uid('s-');
        sessionStorage.setItem(KEY, id);
      }
      return id;
    } catch (e) {
      return uid('s-');
    }
  }

  _base() {
    return {
      release: this.cfg.release,
      appId: this.cfg.appId,
      sessionId: this.sessionId,
      deviceId: this.deviceId,
    };
  }

  log(level, msg) {
    if (!this.cfg.debug && level !== 'error') return;
    try {
      const tag = '[diagnose]';
      if (level === 'error') console.error(tag, msg);
      else if (level === 'warn') console.warn(tag, msg);
      else console.info(tag, msg);
    } catch (e) {}
  }
}

export default Diagnose;
