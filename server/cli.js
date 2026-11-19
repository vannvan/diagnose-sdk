#!/usr/bin/env node
/**
 * cli.js —— 离线解析诊断包
 *
 * 用于「客户不让部署 collector」的场景：
 * 运维把用户导出的诊断包和构建机上的 sourcemap 目录拷到一起，本地跑一次即可。
 *
 * 用法：
 *   node server/cli.js diag_2.3.1_123.json ./sourcemaps
 *   node server/cli.js diag.json ./sourcemaps --out report.txt
 *
 * 诊断包里的 release 会自动匹配 sourcemaps/<release>/ 目录。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createSymbolicator } from './symbolicate.js';

const args = process.argv.slice(2);
const file = args[0];
const mapRoot = args[1] || './sourcemaps';
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : '';

if (!file) {
  console.error('用法: node server/cli.js <诊断包.json> [sourcemap目录] [--out 输出文件]');
  process.exit(1);
}

const sym = createSymbolicator({ root: mapRoot });

/** 从事件里挑出可读的报告字段 */
function describe(ev, idx) {
  const lines = [];
  lines.push(`== 事件 ${idx + 1} ==`);
  lines.push(`类型: ${ev.type}  级别: ${ev.level || '-'}  次数: ${ev.count || 1}`);
  lines.push(`时间: ${ev.ts ? new Date(ev.ts).toISOString() : '-'}  版本: ${ev.release || '-'}`);
  lines.push(`路由: ${ev.route || '-'}`);
  if (ev.api) {
    lines.push(`接口: ${ev.api.method || ''} ${ev.api.url || ''} → ${ev.api.status ?? '-'}` +
      (ev.api.bizCode !== undefined ? ` (code=${ev.api.bizCode})` : '') +
      (ev.api.traceId ? ` trace=${ev.api.traceId}` : ''));
  }
  lines.push(`信息: ${ev.message || '-'}`);

  if (ev.componentStack) {
    const comp = String(ev.componentStack).split('\n').filter(Boolean).slice(0, 6);
    lines.push('组件:');
    comp.forEach((c) => lines.push(`  ${c.trim()}`));
  }
  if (ev.stack) {
    lines.push('堆栈:');
    String(ev.stack).split('\n').forEach((l) => lines.push(`  ${l.trim()}`));
  }
  if (ev.originStack) {
    lines.push('发起位置:');
    String(ev.originStack).split('\n').forEach((l) => lines.push(`  ${l.trim()}`));
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const raw = await fs.readFile(path.resolve(file), 'utf8');
  const pkg = JSON.parse(raw);
  const events = pkg.events || [];
  const release = (pkg.meta && pkg.meta.release) || pkg.release || 'unknown';

  const resolved = await sym.symbolicateEvents(release, events);

  const header = [
    `诊断包: ${path.basename(file)}`,
    `版本: ${release}`,
    `事件数: ${events.length}`,
    `sourcemap 根: ${path.resolve(mapRoot)}`,
    `命中/未命中: ${sym.stats.hits}/${sym.stats.misses}  帧映射: ${sym.stats.mapped}/${sym.stats.frames}`,
    '',
  ].join('\n');

  // 如果一条都没映射成功，多半是 release 目录对不上，这里明确提示
  const warn = sym.stats.mapped === 0
    ? `注意: 没有任何帧被还原，请确认 ${path.resolve(mapRoot)}/${release}/ 下存在对应 .map 文件\n`
    : '';

  const body = resolved.map((ev, i) => describe(ev, i)).join('\n');
  const text = `${header}${warn}${body}`;

  if (outFile) {
    await fs.writeFile(path.resolve(outFile), text, 'utf8');
    console.log(`已写入 ${path.resolve(outFile)}`);
  } else {
    console.log(text);
  }
}

main().catch((e) => {
  console.error('解析失败:', e.message);
  process.exit(1);
});
