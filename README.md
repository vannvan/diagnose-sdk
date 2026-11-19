# diagnose-sdk

私有化部署场景下的**前端阻断性故障采集 SDK**。

只做一件事：**记录"用户在这一步走不下去了"的证据**，本地留存到 IndexedDB，可选上报，也可导出诊断包带回。

不采集业务行为、不采集用户转化——那是神策这类分析平台的事，这里只回答"用户为什么用不了"。

---

## 一、定位与边界

| 该做 | 不该做 |
|---|---|
| 页面白屏、启动失败、chunk 加载失败 | PV/UV、点击热力图、漏斗转化 |
| 关键操作点了没反应（交互事务） | 用户画像、分群、推荐 |
| 主流程接口失败 / 超时 | 采集完整请求体、响应体 |
| 版本 / 路由 / 会话 / trace_id 上下文 | 全量录屏、DOM 快照 |
| 本地持久化 + 可导出取证 | 把原始日志回传到厂商公网 |

**核心约束**：私有化环境下数据往往禁止出内网，所以 SDK 默认是"纯本地模式"，`endpoint` 留空也能完整工作。

---

## 二、目录结构

```
diagnose-sdk/
├── src/
│   ├── env.js      环境探测、哈希、脱敏、文件/调用栈归一化
│   ├── store.js    存储层：IndexedDB → localStorage → 内存 三级降级 + GC
│   ├── collect.js  采集层：全局错误、请求拦截、路由、面包屑、React/Vue 适配
│   ├── probe.js    探针层：白屏检测、关键交互事务
│   └── index.js    主控：阻断判定、内存聚合、落盘、上报、导出
├── server/
│   ├── symbolicate.js  sourcemap 符号化核心（含路径穿越防护）
│   ├── index.js        collector：/report 接收、/symbolicate 还原
│   ├── cli.js          离线解析诊断包（客户不让部署服务时用）
│   └── self-test.mjs   符号化链路自测，18 项断言
├── demo/
│   └── index.html  故障注入验证页
└── package.json
```

前端 SDK 部分零依赖；只有服务端的 `server/` 依赖 `@jridgewell/trace-mapping`。

---

## 三、快速接入

```js
import { Diagnose } from './diagnose-sdk/src/index.js';

const diag = new Diagnose({
  appId: 'console',
  release: __APP_VERSION__,          // 必填，例如 '2.3.1'
  endpoint: '/monitor/report',       // 可选，留空 = 纯本地
  criticalApis: ['/api/login', '/api/order/submit', '/api/pay'],
  ignoreApis: ['/monitor/report', '/health'],
  whiteScreen: {
    selectors: ['#app main', '[data-page-ready]'],
    timeout: 10000,
  },
});

await diag.start();

// 若项目用 axios，显式传入实例（fetch 已被自动包裹，无需处理）
diag.wrapAxios(axiosInstance);

// 业务侧拿到明确成功信号时，可手动结算交互事务
diag.settle('submit-order');

// 导出诊断包（用户反馈问题时触发）
await diag.export();
```

关键交互只需要加属性，不用写代码：

```html
<button data-critical="login"
        data-expect-route="/home"
        data-expect-api="/api/login">登录</button>
```

5 秒内没等到路由跳转或接口成功 → 记一条 `blocked_interaction`。

---

## 四、配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `release` | `''` | **必填**，版本号。缺失会让指纹失去区分度 |
| `endpoint` | `''` | 上报地址。留空则只落本地 |
| `onlyBlock` | `true` | 只收集阻断级，降级事件直接丢弃 |
| `criticalApis` | `[]` | 关键接口前缀，命中才升级为阻断 |
| `ignoreApis` | `[]` | 忽略名单（上报接口会自动忽略） |
| `slowApi` | `5000` | 关键接口慢请求阈值（ms） |
| `apiStack` | `'critical'` | 接口调用栈采集：`critical` / `all` / `off`。默认只对关键接口抓，避免高频请求的性能开销 |
| `flushInterval` | `500` | 缓冲落盘间隔（ms） |
| `batchSize` | `20` | 缓冲种类数达到即落盘 |
| `maxRows` | `2000` | 库内最多保留条数（按指纹聚合后） |
| `ttlDays` | `7` | 保留天数 |
| `interactTimeout` | `5000` | 关键点击无回执判定窗口（ms） |
| `whiteScreen` | `{selectors:[], timeout:10000, everyRoute:false}` | `selectors` 为空则不开启 |
| `breadcrumbMax` | `20` | 事件里附带的面包屑条数 |
| `sampleRate` | `1` | 仅对降级事件生效，阻断级永远全采 |
| `debug` | `false` | 打印内部日志 |
| `beforeSend` | `null` | 事件发出前的钩子，可补充字段或返回 `null` 丢弃 |

---

## 五、阻断判定规则

采集层只管"发生了什么"，`_judge()` 决定"这算不算阻断"。

| 信号 | 判定 |
|---|---|
| 接口 `status === 0`（断网/超时/CORS） | 阻断 |
| 接口 `5xx` | 阻断 |
| 接口 `4xx` | 关键接口阻断，否则降级 |
| 业务码 `code !== 0` | 关键接口阻断，否则降级 |
| 关键接口耗时 > `slowApi` | 阻断 |
| JS 运行时错误 | 阻断 |
| Promise 未处理拒绝 | 降级（大量业务用 reject 做流程控制） |
| 跨域 `Script error.` | 降级（无堆栈，信息量为 0） |
| chunk 加载失败 | 阻断（发版后的确定性崩溃） |
| 资源加载失败 | 阻断 |
| 白屏（关键节点超时未出现） | 阻断 |
| 关键点击 N 秒无预期结果 | 阻断 |

`onlyBlock: true` 时，降级级事件不入库。

---

## 六、可靠性陷阱与对应实现

这是这份 SDK 的重点。下表逐条对应代码位置，便于审查。

| # | 陷阱 | 后果 | 处理方式 | 位置 |
|---|---|---|---|---|
| 1 | Safari 无痕模式 `indexedDB.open` 抛错 | 初始化直接崩溃 | 真实打开测试库探测，失败降级 localStorage | `env.js: probeIndexedDB` |
| 2 | `open()` 永远不回调（存储策略禁用） | 页面初始化卡死 | 2s 超时兜底 | 同上 |
| 3 | 无痕模式 `localStorage.setItem` 抛 QuotaExceededError | 误判可用 | 真实写一次再删，探测可写性 | `env.js: probeLocalStorage` |
| 4 | 配额不足 | 写入失败、数据丢失 | 捕获后降级，并提前用 `storage.estimate()` 判断 | `store.js: _write/_degrade` |
| 5 | 事务内用 `async/await` | 事务提前提交，后续请求静默丢失 | 写入全程回调风格，禁止 async | `store.js: writeIDB` |
| 6 | 并发写事务 | 互相阻塞、聚合计数被旧值覆盖 | Promise 链严格串行化 | `store.js: write/_chain` |
| 7 | 事务内任一 request 报错 | 整批回滚 | 自增主键避免冲突；单条异常单独捕获 | `store.js: writeIDB` |
| 8 | 多标签页版本升级 | `onblocked` 永久阻塞 | 监听 `onversionchange` 主动 close | `store.js: openDB` |
| 9 | `pagehide` 时 IDB 写入被打断 | 最后一批数据丢失 | beacon 直发兜底 + 尽力落盘，双路径 | `index.js: _onPageHide` |
| 10 | 浏览器清理 best-effort 存储 | 数据被回收 | 申请 `navigator.storage.persist()` | `env.js: ensurePersist` |
| 11 | 监控自身抛错触发递归上报 | 无限循环、页面卡死 | `_inRecord` 重入锁 + 全钩子 try/catch | `index.js: record` |
| 12 | 上报接口自身失败触发上报 | 递归上报 | 自动把 `endpoint` 加入忽略名单 | `index.js: _isIgnored` |
| 13 | 循环报错打爆存储 | 库被写满、页面卡顿 | 按指纹内存聚合，count 累加 | `index.js: record` |
| 14 | 同一错误因 ID/行号不同被拆分 | 记录数爆炸 | 指纹前做数字/UUID/十六进制归一化 | `env.js: fingerprint` |
| 15 | 跨域脚本只报 `Script error.` | 无堆栈，无法定位 | 识别并标为降级，不污染阻断率 | `collect.js: hookErrors` |
| 16 | 资源错误不冒泡 | 一个都收不到 | `addEventListener('error', fn, true)` 捕获阶段 | `collect.js: hookErrors` |
| 17 | 业务代码 `stopPropagation` 拦截点击 | 交互事务失效 | 捕获阶段监听 click | `probe.js: start` |
| 18 | `e.target` 是文本节点 | `closest` 不存在，报错 | 判断 `typeof closest === 'function'` | `probe.js: _onClick` |
| 19 | 用户手抖重复点击 | 大量误报 | 同 key 1s 内去重 | `probe.js: _onClick` |
| 20 | 未结算事务堆积 | 内存泄漏 + 定时器堆积 | Map 上限 50，最旧的强制结算；卸载时统一清理 | `probe.js: InteractionTracker` |
| 21 | 客户端时钟错乱 | 数据排序全乱 | 同时记录 `ts` 与相对启动的 `relTs` | `index.js: _enrich` |
| 22 | 白屏探针选择器配错 | 持续误报 | 要求多个选择器"或"关系；只检测首次；报告后立即停止 | `probe.js: startWhiteScreenProbe` |
| 23 | `fetch` 被包裹后语义改变 | 业务 try/catch 失效 | 成功原样返回，失败原样 reject | `collect.js: hookFetch` |
| 24 | 强改 `Request` 对象注入 header | 与 polyfill 冲突报错 | 仅在"字符串 URL + init"场景注入 | 同上 |
| 25 | 热更新重复注册监听 | 监听成倍叠加 | 所有 hook 返回 `off`，`destroy()` 全量卸载 | `index.js: destroy` |
| 26 | 单条事件体积过大 | 超出 sendBeacon 64KB 静默失败 | 栈截断 3000 字符、面包屑截断、包体超限跳过 | `index.js: flushRemote` |
| 27 | 导出包未脱敏 | 安全审查卡住 | 手机号/邮箱/身份证/token 全部打码 | `env.js: mask` |
| 28 | URL 带 token/订单号 | 数据外泄 | 只保留 query 参数名，不留值 | `env.js: stripQuery` |

---

## 七、存储策略

### 数据模型

| Store | 主键 | 索引 | 用途 |
|---|---|---|---|
| `events` | `id` 自增 | `fingerprint` / `ts` / `synced` | 按指纹聚合后的故障记录 |
| `breadcrumbs` | `id` 自增 | `ts` | 操作轨迹（预留） |
| `meta` | `k` | — | 元信息（预留） |

单条事件：

```js
{
  id, fingerprint,
  type,               // js_error / api_error / chunk_error / white_screen / blocked_interaction ...
  level,              // block | degrade
  message, stack, file, line, col,
  api: { url, method, status, bizCode, cost, traceId, error },
  ts, relTs, bootAt, clientTs,
  release, appId, route, sessionId, deviceId,
  count, lastTs, synced,
  ctx: { ua, lang, net, dpr, screen },
  breadcrumbs: [{ t:'click', tag, text, time }]
}
```

### 容量控制

- 按指纹聚合：**行数 ≈ 错误种类数**，而非发生次数
- 上限 `maxRows`（默认 2000），TTL 7 天
- GC 跟随写入触发，30s 节流；从最旧开始删，优先删已同步的
- 硬保底：无论什么规则，至少保留 20 条

### 降级链

```
IndexedDB  →  localStorage（30 条摘要）  →  内存（会话内）
```

当前模式可通过 `diag.store.mode` 读取，诊断包的 `meta.storageMode` 里也会带上——排查"客户那边怎么没数据"时，第一个要看的就是它。

---

## 八、数据怎么取回来

本地存储本身不等于"你能看到"。三条路径：

### 1. 自动上报（推荐，需客户允许内网回传）

```js
endpoint: '/monitor/report'
```

- 本地永远保留，上报成功只打 `synced = 1`，**不删除**
- 定时 + 页面隐藏时 beacon 上报
- 包体超过 60KB 自动跳过本轮，避免静默失败

### 2. 诊断包导出（客户禁止回传时的唯一路径）

```js
await diag.export();   // 下载 diag_<release>_<ts>.json(.gz)
```

包内含 `meta`（含存储模式、IDB 可用性、配额）、`stats`（按类型汇总）、`events`。

建议把入口做成隐藏参数 `?diag=1` 或放进"问题反馈"弹窗，由客服引导用户导出，不要暴露在日常界面。

### 3. 旁路到已有分析平台

如果客户已部署神策/自建埋点，把阻断事件作为一条自定义事件发过去，IndexedDB 只作本地兜底。

---

## 九、源码定位（symbolicate）

### 定位链路的三块拼图

| 拿到什么 | 靠什么字段 | 能回答的问题 |
|---|---|---|
| 哪个组件崩了 | `componentStack` | 是订单页还是结算页？ |
| 哪段业务代码发起的 | `originStack`（接口错误） | 谁调的这个接口？ |
| 源码哪一行 | `stack` + sourcemap | `order.tsx:142` 这一行在做什么？ |

前两个是 SDK 直接采到的，不需要额外部署；第三个必须配 sourcemap 服务。

### 构建要求

```js
// Vite
build: { sourcemap: 'hidden' }     // 生成 map 但不在产物里暴露地址

// Webpack
devtool: 'hidden-source-map'
```

三条硬要求：

1. **文件名必须带 content hash**（`main.a1b2c3.js`）。文件名不带 hash 时，版本一覆盖，历史堆栈会映射到新代码上，比不还原更误导。
2. **产物按 release 归档**，目录名与 SDK 配置里的 `release` 完全一致。
3. **sourcemap 只进内网**。这张 map 等于完整前端源码，绝不能上传到任何公网服务。

### 目录约定

```
sourcemaps/
└── 2.3.1/                      ← 必须等于 cfg.release
    ├── main.a1b2c3.js.map
    └── chunk-order.9f8e7d.js.map
```

### 部署 collector

```bash
MAP_ROOT=./sourcemaps DATA_DIR=./data PORT=8787 node server/index.js
```

| 接口 | 用途 |
|---|---|
| `POST /report` | 接收 SDK 上报，按 `appId/日期.jsonl` 落盘 |
| `POST /symbolicate` | `{ release, stack }` → 还原后的可读栈 |
| `GET /health` | 健康检查 + 缓存命中统计 |

`SYMBOLICATE_ON_INGEST=1` 可让入库时直接还原（便于运维直接看，代价是写入变重）。

### 离线解析（客户不允许部署服务时）

```bash
node server/cli.js diag_2.3.1_1690000000.json ./sourcemaps
node server/cli.js diag.json ./sourcemaps --out report.txt
```

诊断包里的 `release` 会自动匹配 `sourcemaps/<release>/`。若一条都没还原，CLI 会明确提示版本目录不匹配——这是实际排查中最常见的失败原因。

### 还原后的效果

```
类型: api_error  级别: block  次数: 3
路由: /order/detail
接口: POST /api/order/submit → 500 trace=t-8f2a1c
组件: OrderPage > SubmitButton
信息: 接口异常 POST /api/order/submit status=500
发起位置:
    at submitOrder (src/pages/order.tsx:142:9)
堆栈:
    at handleSubmit (src/components/SubmitButton.tsx:58:5)
```

一条记录同时回答了「哪个页面、哪个组件、哪个函数、哪一行、调了哪个接口、后端 trace 是多少」。

### 自测

```bash
npm run test:symbolicate     # 18 项断言：帧解析、路径穿越防护、还原、容错
```

## 十、验证

```bash
cd diagnose-sdk
npm run demo          # 或 python3 -m http.server 8080
# 打开 http://localhost:8080/demo/
```

页面内置故障注入按钮：JS 错误、Promise 拒绝、接口 404/500、chunk 失败、白屏、关键点击无回执，可逐项验证采集与判定。

ES Module 必须通过 HTTP 访问，直接双击 `file://` 打开会被浏览器拦截。

---

## 十一、已知限制与扩展点

- **`componentStack` 需要业务接入**：React 要在 ErrorBoundary 的 `componentDidCatch` 里换成 `diag.getReactErrorHandler()`（React 19 可直接传给 `createRoot` 的 `onUncaughtError`）；Vue 调一次 `diag.bindVue(app)`。不接也能采到源码行，只是缺"哪个组件"这一层。
- **`originStack` 默认只对关键接口抓**：`apiStack: 'all'` 会给每次请求增加建栈开销，排查期临时打开即可，别长期开着。
- **sourcemap `sources` 路径清洗**：默认会去掉 `webpack://` 前缀；如果客户构建配置产出了自定义协议前缀，需要调 `symbolicate.js` 里的 `replace` 规则。
- **白屏判定依赖选择器**：配错会误报，接入时要和业务一起确认"首屏必须可见"的节点；默认要求节点存在且可见（`getClientRects`），避免"渲染了但高度为 0"漏判。
- **多标签页共库**：当前用串行化写入规避冲突，若要严格单写，可加 `navigator.locks`。
- **`meta` / `breadcrumbs` 表**：目前面包屑随事件内联，独立表已建好但未启用，可用于后续做"错误前 N 步回放"。
- **告警**：SDK 只管采集，影响面分级告警应在服务端做（`受影响会话数 × 阻断类型权重`）。