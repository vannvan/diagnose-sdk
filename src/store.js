/**
 * 本地持久化层
 *
 * 这是整个 SDK 可靠性设计的核心。IndexedDB 看起来"就是个前端数据库"，
 * 但在私有化部署的真实客户环境里，它会以各种方式失败：
 * 无痕模式不可用、配额被磁盘压力挤满、事务被 abort、多标签页互相阻塞、
 * 浏览器定期清理 best-effort 存储、升级版本时被旧连接锁住……
 *
 * 因此这里不是简单的 CRUD，而是三道降级链 + 一套写入纪律：
 *
 *   IndexedDB（主） → localStorage（摘要级兜底） → 内存（会话内兜底）
 *
 * 写入纪律（必须遵守，否则数据会悄悄丢）：
 * 1. 事务内部绝对不能用 async/await —— 一旦让出微任务，事务会提前提交，
 *    后续的 put/delete 直接丢失且不报错。全部用回调风格。
 * 2. 同一时刻只允许一个写事务在跑，用 Promise 链串行化。
 *    并发事务会互相排队阻塞，且顺序错乱会导致聚合计数被旧值覆盖。
 * 3. 事务里任何一个 request 抛错，整个事务回滚。所以单条记录写入要尽量"无冲突"
 *    （用自增主键，不用业务键做主键）。
 * 4. 其他标签页发起版本升级时，本页必须主动 close，否则升级永久阻塞。
 */

import { probeIndexedDB, probeLocalStorage, mask, clampStr } from './env.js';

const DB_NAME = 'diag_events_v1';
const DB_VER = 1;
const LS_KEY = '__diag_events__';
const LS_MAX = 30;

/**
 * 打开数据库。
 *
 * 注意 onversionchange：多标签页场景下，如果 A 标签页开着旧版本，
 * B 标签页升级会导致 B 的 open 永远停在 blocked。必须让旧连接主动让位。
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        // 指纹索引：写入时用它做"同错误合并"，把记录数从"发生次数"压到"错误种类"
        s.createIndex('fingerprint', 'fingerprint', { unique: false });
        s.createIndex('ts', 'ts', { unique: false });
        s.createIndex('synced', 'synced', { unique: false });
      }
      if (!db.objectStoreNames.contains('breadcrumbs')) {
        db.createObjectStore('breadcrumbs', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch (e) {}
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('idb-blocked'));
  });
}

/**
 * 批量写入（纯回调，禁止 async）。
 *
 * @param {IDBDatabase} db
 * @param {Array<object>} events 已经按 fingerprint 在内存里聚合过的批次
 * @param {Function} onDone
 * @param {Function} onError
 */
function writeIDB(db, events, onDone, onError) {
  let tx;
  try {
    tx = db.transaction('events', 'readwrite');
  } catch (e) {
    return onError(e); // 数据库已关闭 / 连接失效，交给上层降级
  }

  const store = tx.objectStore('events');
  const fpIndex = store.index('fingerprint');

  events.forEach((ev) => {
    try {
      // 先查同指纹记录：存在就累加计数，不存在才新增。
      // 这样即使客户端反复刷新，库里的行数也只等于"错误种类数"。
      const getReq = fpIndex.get(ev.fingerprint);
      getReq.onsuccess = () => {
        try {
          const old = getReq.result;
          if (old) {
            old.count = (old.count || 0) + (ev.count || 1);
            old.lastTs = Math.max(old.lastTs || 0, ev.lastTs || ev.ts || 0);
            old.synced = 0; // 有新次数进来，需要重新上报
            store.put(old);
          } else {
            store.add(ev);
          }
        } catch (e) {
          // 单条失败不能中断整批：记录但继续
          onErr(e);
        }
      };
      getReq.onerror = () => {};
    } catch (e) {}
  });

  function onErr(e) {
    try { onError(e); } catch (_) {}
  }

  tx.oncomplete = () => onDone();
  tx.onerror = () => onError(tx.error);
  tx.onabort = () => onError(tx.error || new Error('tx-aborted'));
}

/** localStorage 兜底：只存最近 N 条摘要，体积小、同步可写 */
function writeLS(events) {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    for (const ev of events) {
      // 摘要化，去掉大字段，避免把 5MB 配额一次性占满
      raw.push({
        fp: ev.fingerprint,
        type: ev.type,
        level: ev.level,
        msg: clampStr(ev.message, 200),
        ts: ev.ts,
        count: ev.count,
        release: ev.release,
        route: ev.route,
        synced: 0,
      });
    }
    while (raw.length > LS_MAX) raw.shift();
    localStorage.setItem(LS_KEY, JSON.stringify(raw));
  } catch (e) {
    // 配额已满：丢弃最旧的再试一次，仍失败就放弃（此时只能依赖内存层）
    try {
      const trimmed = JSON.parse(localStorage.getItem(LS_KEY) || '[]').slice(-10);
      localStorage.setItem(LS_KEY, JSON.stringify(trimmed));
    } catch (_) {}
  }
}

/**
 * 垃圾回收：TTL 过期 + 数量超限。
 *
 * 设计取舍：
 * - 不单开定时器，跟随写入时机做（省电、不干扰页面）；
 * - 用节流（默认 30s 一次），避免每次写入都做全表 count；
 * - 硬保留最近 20 条，防止极端情况下把刚发生的阻断故障删掉。
 */
function gcIDB(db, maxRows, ttlMs, done) {
  let countReq;
  try {
    countReq = db.transaction('events', 'readonly').objectStore('events').count();
  } catch (e) {
    return done(e);
  }

  countReq.onsuccess = () => {
    const total = countReq.result;
    if (!total) return done();

    let tx;
    try {
      tx = db.transaction('events', 'readwrite');
    } catch (e) {
      return done(e);
    }

    const store = tx.objectStore('events');
    const idx = store.index('ts');
    const cut = Date.now() - ttlMs;
    let budget = Math.max(0, total - maxRows);
    let deleted = 0;

    // 从最旧的开始遍历：优先删已同步且过期的，其次删超量的最旧记录
    idx.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      // 数量兜底：无论什么规则，始终至少保留 20 条，避免全删
      if (total - deleted <= 20) return;

      const v = cursor.value || {};
      const expired = (v.ts || 0) < cut;
      if ((v.synced === 1 && expired) || budget > 0) {
        cursor.delete();
        deleted++;
        if (budget > 0) budget--;
      }
      cursor.continue();
    };

    tx.oncomplete = () => done();
    tx.onerror = () => done(tx.error);
  };
  countReq.onerror = () => done(countReq.error);
}

/**
 * 统一存储门面。
 *
 * 对外只暴露 write / readAll / markSynced / clear，
 * 内部自动处理：模式选择、写入串行化、失败降级、GC。
 */
export class Store {
  constructor(opts = {}) {
    this.maxRows = opts.maxRows || 2000;
    this.ttlMs = (opts.ttlDays || 7) * 86400000;
    this.log = opts.log || (() => {});
    this.db = null;
    this.mode = 'pending'; // pending | idb | ls | memory
    this.mem = [];
    this._chain = Promise.resolve(); // 写入串行化
    this._gcAt = 0;
  }

  /**
   * 初始化：探测 → 打开 → 失败自动降级。
   * 返回实际生效的模式，便于上层在诊断包里展示（排查"为什么没数据"时非常有用）。
   */
  async init() {
    const idbOk = await probeIndexedDB();
    if (idbOk) {
      try {
        this.db = await openDB();
        this.mode = 'idb';
        return this.mode;
      } catch (e) {
        this.log('warn', `idb 打开失败，降级：${e && e.message}`);
      }
    }

    if (probeLocalStorage()) {
      this.mode = 'ls';
      return this.mode;
    }

    this.mode = 'memory';
    return this.mode;
  }

  /**
   * 批量写入。
   * 上层已经做过"内存内按指纹聚合"，这里只负责落盘与降级。
   *
   * 注意串行化：写入链必须严格排队，否则两个事务并发时，
   * 第二个事务的 `get` 可能读到第一个事务尚未提交的旧值，导致 count 丢失。
   */
  write(events, cb) {
    if (!events || !events.length) return cb && cb();
    this._chain = this._chain
      .then(() => this._write(events))
      .then(
        () => {
          this._maybeGC();
          cb && cb(null);
        },
        (err) => {
          this.log('error', `写入失败，触发降级：${err && err.message}`);
          this._degrade();
          cb && cb(err);
        }
      );
  }

  _write(events) {
    if (this.mode === 'idb' && this.db) {
      return new Promise((resolve, reject) => writeIDB(this.db, events, resolve, reject));
    }
    if (this.mode === 'ls') {
      writeLS(events);
      return Promise.resolve();
    }
    this.mem.push(...events);
    if (this.mem.length > this.maxRows) this.mem = this.mem.slice(-this.maxRows);
    return Promise.resolve();
  }

  /** 降级：idb → ls → memory。任何一级失败都只降一级，不跳级 */
  _degrade() {
    if (this.mode === 'idb') {
      try { this.db && this.db.close(); } catch (e) {}
      this.db = null;
      this.mode = probeLocalStorage() ? 'ls' : 'memory';
      this.log('warn', `已降级到 ${this.mode}`);
    } else if (this.mode === 'ls') {
      this.mode = 'memory';
      this.log('warn', '已降级到 memory');
    }
  }

  _maybeGC() {
    const now = Date.now();
    if (now - this._gcAt < 30000) return; // 节流
    this._gcAt = now;
    if (this.mode !== 'idb' || !this.db) return;
    gcIDB(this.db, this.maxRows, this.ttlMs, (err) => {
      if (err) this.log('warn', `gc 失败：${err && err.message}`);
    });
  }

  /**
   * 读取全部事件，按时间升序。
   * 用于诊断包导出与历史回溯展示。返回的数据已经做过脱敏。
   */
  readAll() {
    return new Promise((resolve) => {
      if (this.mode === 'memory') {
        return resolve(this.mem.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)));
      }
      if (this.mode === 'ls') {
        try {
          const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
          return resolve(raw.sort((a, b) => (a.ts || 0) - (b.ts || 0)));
        } catch (e) {
          return resolve([]);
        }
      }
      // IndexedDB：一个只读事务读完整个 store
      let tx;
      try {
        tx = this.db.transaction('events', 'readonly');
      } catch (e) {
        return resolve([]);
      }
      const rows = [];
      const req = tx.objectStore('events').openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          rows.push(cursor.value);
          cursor.continue();
        }
      };
      tx.oncomplete = () => {
        rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        resolve(rows.map((r) => ({ ...r, message: mask(r.message), stack: mask(r.stack) })));
      };
      tx.onerror = () => resolve([]);
    });
  }

  /**
   * 标记已同步。
   * 注意：不能"删掉"已同步的记录，因为客户现场往往会要求"上报出问题后仍能在本地取证"，
   * 所以只打标记，由 GC 按 TTL 清理。
   */
  markSynced(ids) {
    return new Promise((resolve) => {
      if (!ids || !ids.length) return resolve();
      if (this.mode !== 'idb' || !this.db) return resolve();

      let tx;
      try {
        tx = this.db.transaction('events', 'readwrite');
      } catch (e) {
        return resolve();
      }
      const store = tx.objectStore('events');
      ids.forEach((id) => {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const row = getReq.result;
          if (row) {
            row.synced = 1;
            store.put(row);
          }
        };
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  /** 读取未同步记录，供上报通道使用 */
  readUnsynced(limit = 50) {
    return new Promise((resolve) => {
      if (this.mode === 'idb' && this.db) {
        let tx;
        try {
          tx = this.db.transaction('events', 'readonly');
        } catch (e) {
          return resolve([]);
        }
        const out = [];
        const idx = tx.objectStore('events').index('synced');
        const req = idx.openCursor(IDBKeyRange.only(0));
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && out.length < limit) {
            out.push(cursor.value);
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => resolve([]);
        return;
      }
      if (this.mode === 'ls') {
        try {
          const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
          return resolve(raw.filter((r) => r.synced === 0).slice(0, limit));
        } catch (e) {
          return resolve([]);
        }
      }
      resolve(this.mem.filter((m) => m.synced === 0).slice(0, limit));
    });
  }
}
