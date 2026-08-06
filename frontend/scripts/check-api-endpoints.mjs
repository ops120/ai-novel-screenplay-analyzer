#!/usr/bin/env node
// v22.1：禁用地址扫描器
// 业务代码（src/）禁止出现 127.0.0.1:8000 / localhost:8000 等已废弃后端端口。
// 唯一允许出现 host/port 的位置是 vite.config.js 的 proxy target 和
// 部署 nginx 的 upstream。扫描命中即非零退出，pretest 钩子会拦截。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FORBIDDEN = [
  // 旧后端端口（v10 之前用 8000，v10 改 28000 后业务代码未跟上）
  { re: /127\.0\.0\.1:8000\b/, why: '后端已迁到 28000；浏览器只允许请求同源 /api' },
  { re: /localhost:8000\b/,  why: '后端已迁到 28000；浏览器只允许请求同源 /api' },
];

// 允许出现这些模式的文件：vite.config.js / package.json / scripts/ / 部署文档
const ALLOWLIST_FILES = new Set([
  path.join(ROOT, 'vite.config.js'),
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'package-lock.json'),
  path.join(ROOT, 'scripts', 'check-api-endpoints.mjs'),  // 自身
]);

// 不扫描的目录
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'scripts']);

const TARGET_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.html', '.css']);

function* walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) yield* walk(p);
    else if (TARGET_EXTS.has(path.extname(p))) yield p;
  }
}

let hits = 0;
const fileHits = [];

for (const file of walk(path.join(ROOT, 'src'))) {
  if (ALLOWLIST_FILES.has(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const { re, why } of FORBIDDEN) {
      const m = line.match(re);
      if (m) {
        hits += 1;
        const rel = path.relative(ROOT, file);
        fileHits.push({ file: rel, line: idx + 1, match: m[0], why });
        console.error(`  ✗ ${rel}:${idx + 1}  命中 "${m[0]}" — ${why}`);
      }
    }
  });
}

if (hits > 0) {
  console.error(`\n[check-api-endpoints] FAIL：发现 ${hits} 处禁用地址。`);
  console.error('  修复方法：业务代码用 src/config.js 的 API_BASE / apiFetch，');
  console.error('  端口变更只改 vite.config.js 的 proxy target 和部署 nginx upstream。\n');
  process.exit(1);
} else {
  console.log('[check-api-endpoints] OK：未发现 127.0.0.1:8000 / localhost:8000 硬编码。');
}
