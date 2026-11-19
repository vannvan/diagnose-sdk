/**
 * collect.js —— 采集钩子层
 *
 * 职责：把浏览器里能拿到的"故障信号"接出来，做初步归一化后交给 SDK 主控。
 * 这一层不负责"判断是不是阻断"（那是 judge 的事），也不负责存储。
 *
 * 三个必须遵守的纪律：
 * 1. 所有钩子内部必须 try/catch。钩子抛错会被浏览器上报成"监控自己的错误"，
 *    形成无限递归（report → error → report → error…）。
 * 2. 所有钩子必须可卸载（返回 off 函数），SDK.destroy() 时能干净退出，
 *    否则热更新/单页切换场景下会重复注册监听。
 * 3. 所有用户回调（如 onEvent）都要包一层 safe()，业务回调抛错不能影响采集。
 */

import {
  safe, stripQuery, uid, clampStr, mask,
  captureStack, normalizeFile, normalizeStack,
} from './env.js';

/** 判断是否是"资源加载失败"，而不是 JS 运行时错误 */
function isResourceError(e) {
  const t = e && e.target;
  if (!t || t === window) return false;
  return (
    t instanceof HTMLScriptElement ||
    t instanceof HTMLLinkElement ||
    t instanceof HTMLImageElement ||
    t instanceof HTMLVideoElement ||
    t instanceof HTMLAudioElement ||
    (typeof t.tagName === 'string' && /^(SCRIPT|LINK|IMG|VIDEO|AUDIO|SOURCE)$/.test(t.tagName))
  );
}

/** chunk 加载失败的识别。
 *
 * 这是发版后最常见的一类"阻断"：旧标签页还在用旧版 index.html，
 * 但它请求的新版本 chunk 已经被覆盖成 404，动态 import 直接 TypeError。
 * 不同打包器文案不同，所以用多组正则兜。
 */
const CHUNK_PATTERNS = [
  /Loading chunk \S+ failed/i,                    // webpack 4
  /Loading CSS chunk \S+ failed/i,                // webpack 5 css
  /ChunkLoadError/i,                              // webpack 5
  /Failed to fetch dynamically imported module/i, // vite / esm
  /Importing a module script failed/i,            // safari
  /Unable to preload CSS/i,                       // vite
];

function isChunkError(message) {
  const m = String(message || '');
  return CHUNK_PATTERNS.some((re) => re.test(m));
}

/* fetch 的重复挂载保护由 SDK 实例的 _offs 统一管理，这里不再额外包裹 */


/**
 * 注册全局错误钩子。
 *
 * @param {(ev: object) => void} record
 * @param {() => object} base 返回公共上下文（release/deviceId/sessionId 等）
 * @returns {Function} off
 */
export function hookErrors(record, base) {
  const onError = (e) => {
    safe(() => {
      // 情况一：资源加载失败（IMG/SCRIPT/LINK）。注意这类事件不冒泡，
      // 所以必须用捕获阶段（第三个参数 true）才能监听到。
      if (isResourceError(e)) {
        const tag = e.target.tagName;
        const src = e.target.src || e.target.href || '';
        record({
          type: 'resource_error',
          message: `资源加载失败: ${tag} ${clampStr(stripQuery(src), 300)}`,
          // 资源失败往往是 CDN/静态服务故障，属于阻断级（页面样式或脚本缺失）
          level: 'block',
          extra: { tag, url: stripQuery(src) },
        });
        return;
      }

      // 情况二：跨域脚本错误。不做 crossorigin 时，浏览器只给 "Script error."，
      // 拿不到栈。这类事件信息量为 0，按降级级记录，避免污染阻断率。
      const message = e.message || '';
      const chunk = isChunkError(message);
      const isCrossOriginVoid = /^Script error\.?$/i.test(message);

      record({
        type: chunk ? 'chunk_error' : 'js_error',
        message: isCrossOriginVoid
          ? '跨域脚本错误（缺少 crossorigin 属性，无法获取堆栈）'
          : clampStr(message, 500),
        stack: clampStr(normalizeStack(e.error && e.error.stack), 3000),
        file: clampStr(normalizeFile(e.filename), 300),
        line: e.lineno,
        col: e.colno,
        level: chunk ? 'block' : isCrossOriginVoid ? 'degrade' : 'block',
        extra: { crossOriginVoid: isCrossOriginVoid },
      });
    });
  };

  const onRejection = (e) => {
    safe(() => {
      const r = e.reason;
      const msg = r && (r.message || String(r)) || 'unknown rejection';
      record({
        type: isChunkError(msg) ? 'chunk_error' : 'promise_error',
        message: clampStr(msg, 500),
        stack: clampStr(normalizeStack(r && r.stack), 3000),
        // Promise 拒绝不一定阻断：很多业务代码用 reject 做流程控制
        level: 'degrade',
      });
    });
  };

  // 第三个参数 true = 捕获阶段。少了这个参数，资源错误一个都收不到。
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection, false);

  return () => {
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection, false);
  };
}

/**
 * 路由变化钩子。
 *
 * 为什么不用框架的 router API：私有化交付面对的是客户已有的各种框架（React/Vue/Angular/原生），
 * 统一改 history 是最通用的做法，零框架依赖。
 *
 * 陷阱：patch history 之后如果别的库也 patch（如某些埋点 SDK），
 * 顺序不同会导致互相覆盖，所以要用"只包一次 + 保留原函数引用"的方式。
 */
export function hookRoute(onChange) {
  const origPush = history.pushState;
  const origReplace = history.replaceState;

  const handler = () => safe(() => onChange(getRoute()));

  history.pushState = function (...args) {
    const r = origPush.apply(this, args);
    handler();
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args);
    handler();
    return r;
  };
  window.addEventListener('popstate', handler);
  window.addEventListener('hashchange', handler);

  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener('popstate', handler);
    window.removeEventListener('hashchange', handler);
  };
}

/** 取当前路由（path 部分足够定位，不采完整 query 避免泄露参数） */
export function getRoute() {
  try {
    return location.pathname + location.hash.split('?')[0];
  } catch (e) {
    return '';
  }
}

/**
 * 包裹 fetch。
 *
 * 关键约束：不能改变 fetch 的语义。
 * - 成功时原样返回 Response；
 * - 失败时记录后必须原样 reject，否则业务代码的 try/catch 会失效；
 * - 不能强行改写 Request 对象（会被某些 polyfill 报错），只在能安全注入时加 trace header。
 *
 * @param {object} opts { judgeApi(url, status), onTrace(traceId) }
 * @returns {Function} off
 */
export function hookFetch(opts, base) {
  if (typeof window.fetch !== 'function') return () => {};

  const origFetch = window.fetch;

  const patched = function (input, init) {
    const start = Date.now();
    let url = '';
    let method = 'GET';
    let traceId = uid('t-');

    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
      method = (init && init.method) || (input && input.method) || 'GET';

      // 只对"字符串 URL + 有 init 对象"的情况注入，避免改动 Request 实例
      if (typeof input === 'string' && init && init.headers) {
        const h = new Headers(init.headers);
        if (!h.has('X-Trace-Id')) h.set('X-Trace-Id', traceId);
        init = { ...init, headers: h };
      } else if (typeof input === 'string' && !init) {
        init = { headers: { 'X-Trace-Id': traceId } };
      }
    } catch (e) {}

    const p = origFetch.call(window, input, init);

    // 关键：调用栈必须在"发起请求的此刻"抓取。
    // 等请求失败回调时再抓，栈里只剩下拦截器自己的帧，拿不到业务代码位置。
    // 默认只对关键接口抓，避免列表页几十个并发请求都去做栈采集。
    let originStack = '';
    try {
      if (opts.needStack && opts.needStack(url)) originStack = captureStack(5);
    } catch (e) {}

    // 注意：这里不能 return await，否则会多一层微任务，改变调用栈行为。
    // 用 then 链保证返回的仍是 Promise<Response>。
    return p.then(
      (res) => {
        safe(() => {
          // 成功也要回调一次：交互事务需要"接口成功"作为结算信号，
          // 否则声明了 expect-api 的关键按钮会永远等不到结果、全部误判为阻断。
          // 注意：index 层对 ok=true 只做结算、不记录，所以这里不会产生噪音数据。
          opts.onApi({
            url: stripQuery(url),
            method,
            status: res ? res.status : 0,
            ok: !!(res && res.ok),
            cost: Date.now() - start,
            traceId,
            originStack,
          });
        });
        return res;
      },
      (err) => {
        safe(() => {
          // status 0 表示网络层失败（断网 / DNS / 超时 / CORS 预检失败）
          opts.onApi({
            url: stripQuery(url),
            method,
            status: 0,
            ok: false,
            cost: Date.now() - start,
            traceId,
            originStack,
            error: clampStr(err && err.message, 300),
          });
        });
        throw err; // 必须原样抛出
      }
    );
  };

  try {
    window.fetch = patched;
  } catch (e) {
    return () => {};
  }

  return () => {
    try {
      if (window.fetch === patched) window.fetch = origFetch;
    } catch (e) {}
  };
}

/**
 * 包裹 axios 实例（不自动生效，需业务显式调用）。
 *
 * 为什么不自动挂：axios 是 npm 依赖，SDK 不应该去猜业务怎么引入它
 * （可能是多实例、可能是 request 库、可能是 umi-request）。
 * 显式传入实例最稳妥。
 *
 * @param {object} instance axios 实例
 * @param {object} opts { onApi(payload) }
 */
export function wrapAxios(instance, opts) {
  if (!instance || typeof instance.interceptors !== 'object') return () => {};

  const reqId = instance.interceptors.request.use((config) => {
    safe(() => {
      config.__diagStart = Date.now();
      config.__diagTrace = uid('t-');
      // 注入 trace，让前后端日志可以对上（排查接口报错的核心手段）
      if (config.headers && typeof config.headers.set === 'function') {
        config.headers.set('X-Trace-Id', config.__diagTrace);
      } else if (config.headers) {
        config.headers['X-Trace-Id'] = config.__diagTrace;
      }
      // 与 fetch 同理：栈必须在请求发起时抓，否则回调里只剩拦截器帧
      if (opts.needStack && opts.needStack(config.url)) {
        config.__diagStack = captureStack(5);
      }
    });
    return config;
  });

  const resId = instance.interceptors.response.use(
    (res) => {
      safe(() => {
        // 业务码错误：HTTP 200 但 code != 0，属于最常见的"接口报错"
        const body = res && res.data;
        const bizCode = body && (body.code !== undefined ? body.code : body.errcode);
        const cfg = (res && res.config) || {};
        const cost = Date.now() - (cfg.__diagStart || Date.now());

        if (bizCode !== undefined && bizCode !== 0 && bizCode !== '0') {
          opts.onApi({
            url: stripQuery(cfg.url || ''),
            method: (cfg.method || 'get').toUpperCase(),
            status: res.status,
            bizCode,
            ok: false,
            cost,
            traceId: cfg.__diagTrace,
            originStack: cfg.__diagStack || '',
          });
        } else {
          // 成功回调仅用于交互事务结算，不产生故障记录
          opts.onApi({
            url: stripQuery(cfg.url || ''),
            method: (cfg.method || 'get').toUpperCase(),
            status: res.status,
            ok: true,
            cost,
            traceId: cfg.__diagTrace,
          });
        }
      });
      return res;
    },
    (err) => {
      safe(() => {
        const cfg = (err && err.config) || {};
        const res = err && err.response;
        opts.onApi({
          url: stripQuery(cfg.url || ''),
          method: (cfg.method || 'get').toUpperCase(),
          status: res ? res.status : 0,
          bizCode: res && res.data && res.data.code,
          ok: false,
          cost: Date.now() - (cfg.__diagStart || Date.now()),
          traceId: cfg.__diagTrace,
          originStack: cfg.__diagStack || '',
          error: clampStr(err && err.message, 300),
        });
      });
      return Promise.reject(err);
    }
  );

  return () => {
    try {
      instance.interceptors.request.eject(reqId);
      instance.interceptors.response.eject(resId);
    } catch (e) {}
  };
}

/** 面包屑：记录用户最近的操作轨迹，用于还原"卡在哪一步" */
export function createBreadcrumb(max = 100) {
  const list = [];

  const push = (item) => {
    safe(() => {
      list.push({ ...item, t: Date.now() });
      if (list.length > max) list.shift();
    });
  };

  const onClick = (e) => {
    safe(() => {
      const t = e.target;
      if (!t || !t.tagName) return;
      const text = (t.getAttribute && (t.getAttribute('data-critical') || t.getAttribute('aria-label')) ||
        (t.innerText || '').trim().slice(0, 30)) || '';
      push({ t: 'click', tag: t.tagName.toLowerCase(), text: mask(text) });
    });
  };

  const onRoute = (route) => push({ t: 'route', route });

  document.addEventListener('click', onClick, true);

  return {
    push,
    onRoute,
    get: () => list.slice(),
    off: () => document.removeEventListener('click', onClick, true),
  };
}

/**
 * React 错误处理适配器。
 *
 * React 有两种拿得到"组件树"的场景，签名一致，所以统一成一个 handler：
 *   - React 18-：ErrorBoundary 的 componentDidCatch(error, info)
 *   - React 19：createRoot(el, { onUncaughtError: (error, errorInfo) => ... })
 *
 * 为什么组件栈比源码行号更好用：排查时第一个问题永远是"哪个页面/组件崩了"，
 * componentStack 能直接给出 `OrderPage > SubmitButton` 这样的路径，
 * 源码行号只有在 symbolicate 之后才有同等价值。
 *
 * @param {(payload: {error: Error, componentStack?: string}) => void} onError
 * @returns {(error: Error, info?: {componentStack?: string}) => void}
 */
export function createReactHandler(onError) {
  return (error, info) => {
    safe(() => {
      onError({
        error,
        componentStack: info && info.componentStack ? clampStr(info.componentStack, 1500) : '',
      });
    });
  };
}

/**
 * Vue 2/3 全局错误处理绑定。
 *
 * 陷阱：app.config.errorHandler 很可能已经被业务自己的错误上报占用。
 * 这里采用"链式调用"而不是直接覆盖——先记我们的，再调原来的，
 * 否则接入本 SDK 会导致业务原有错误处理静默失效，这类问题在客户现场极难排查。
 *
 * @param {object} app Vue 应用实例
 * @param {(payload: {error: Error, componentStack: string}) => void} onError
 * @returns {Function} 解绑函数
 */
export function bindVue(app, onError) {
  if (!app || !app.config) return () => {};
  const prev = app.config.errorHandler;

  app.config.errorHandler = (err, vm, info) => {
    safe(() => {
      // info 是 Vue 给的生命周期描述（如 "render" / "mounted hook"），配合组件名定位
      const name = (vm && vm.$options && vm.$options.name) || 'anonymous';
      onError({
        error: err,
        componentStack: `${name} @ ${info || 'unknown'}`,
      });
    });
    // 保留业务原有处理逻辑，不能吞掉
    if (typeof prev === 'function') return prev(err, vm, info);
    return undefined;
  };

  return () => {
    app.config.errorHandler = prev;
  };
}

/**
 * 包装 ErrorBoundary 的 componentDidCatch 语义，便于直接替换。
 * 用法：componentDidCatch = diag.getReactErrorHandler()
 */
export function createBoundaryHandler(onError) {
  const handler = createReactHandler(onError);
  return (error, info) => handler(error, info);
}
