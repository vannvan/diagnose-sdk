/**
 * self-test.mjs —— 符号化链路自测
 *
 * 不依赖任何测试框架，直接 `node server/self-test.mjs` 运行。
 * 目的是验证：sourcemap 能被读出来、帧能被正确解析、位置能正确还原、
 * 以及路径穿越防护确实生效。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createSymbolicator, parseFrame, safeFileName } from './symbolicate.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 最小 VLQ 编码器，用来手工构造测试用 sourcemap */
function vlq(value) {
  let v = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/** 构造"第 1 行第 0 列 → sources[0] 第 1 行第 0 列, name[0]" */
const MAPPINGS = ['0', '0', '0', '0', '0'].map((n) => vlq(Number(n))).join('');

const TMP_ROOT = '/tmp/diag-selftest-maps';
const RELEASE = '1.0.0';
const BUNDLE = 'main.abc123.js';

let pass = 0;
let fail = 0;

function assert(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' → ' + detail : ''}`);
  }
}

async function main() {
  // 准备测试用 sourcemap
  const dir = path.join(TMP_ROOT, RELEASE);
  await fs.mkdir(dir, { recursive: true });
  const map = {
    version: 3,
    file: BUNDLE,
    sources: ['src/pages/order.tsx'],
    names: ['submitOrder'],
    mappings: MAPPINGS,
  };
  await fs.writeFile(path.join(dir, BUNDLE + '.map'), JSON.stringify(map), 'utf8');

  // 1. 帧解析
  console.log('\n[1] 帧解析');
  const f1 = parseFrame(`    at submitOrder (/static/js/${BUNDLE}:1:0)`);
  assert('带函数名的帧', !!f1, JSON.stringify(f1));
  assert('解析出函数名', f1 && f1.fn === 'submitOrder', f1 && f1.fn);
  assert('解析出行列', f1 && f1.line === 1 && f1.column === 0);

  const f2 = parseFrame(`    at /static/js/${BUNDLE}:1:0`);
  assert('无函数名的帧', !!f2 && f2.fn === '');

  const f3 = parseFrame(`    at async loadData (http://10.0.0.1/js/${BUNDLE}:1:0)`);
  assert('async 前缀帧', !!f3 && f3.url.includes(BUNDLE), f3 && f3.url);

  const f4 = parseFrame('TypeError: boom');
  assert('非帧行被忽略', f4 === null);

  // 2. 路径穿越防护
  console.log('\n[2] 路径穿越防护');
  assert('拒绝 ../ 路径', safeFileName('../../etc/passwd') === null);
  assert('拒绝带斜杠', safeFileName('a/b.js') === null);
  assert('拒绝非 js 后缀', safeFileName('main.js.txt') === null);
  assert('接受合法文件名', safeFileName(BUNDLE) === BUNDLE);

  // 3. 符号化
  console.log('\n[3] 符号化');
  const sym = createSymbolicator({ root: TMP_ROOT });
  const stack = `TypeError: Cannot read properties of undefined (reading 'id')
    at submitOrder (/static/js/${BUNDLE}:1:0)
    at <anonymous> (/static/js/${BUNDLE}:1:0)`;

  const out = await sym.symbolicate(RELEASE, stack);
  console.log('\n还原结果:\n' + out + '\n');

  assert('首行 message 保留', out.startsWith("TypeError: Cannot read properties of undefined"));
  assert('还原出源码文件', out.includes('src/pages/order.tsx'), out);
  assert('还原出原始行号', /src\/pages\/order\.tsx:1:0/.test(out), out);
  assert('还原出原始函数名', out.includes('submitOrder'));
  assert('至少还原 1 帧', sym.stats.mapped >= 1, String(sym.stats.mapped));

  // 4. 找不到 map 时不能崩
  console.log('\n[4] 容错');
  const out2 = await sym.symbolicate(RELEASE, `Error: x\n    at foo (/static/js/${'missing.js'}:1:0)`);
  assert('缺 map 时原样返回', out2.includes('missing.js'), out2);
  assert('缺 map 不抛错', true);

  const out3 = await sym.symbolicate('9.9.9', stack);
  assert('release 不匹配时原样返回', out3.includes(BUNDLE), out3);

  // 清理
  await fs.rm(TMP_ROOT, { recursive: true, force: true });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('自测异常:', e);
  process.exit(1);
});
