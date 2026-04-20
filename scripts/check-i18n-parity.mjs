#!/usr/bin/env node
/**
 * i18n 完整性检查:对比 12 语言 × 8 命名空间的所有 key 是否完全一致。
 *
 * 用法:
 *   node scripts/check-i18n-parity.mjs          # 全量检查,任一语言缺失/多余就 exit 1
 *   node scripts/check-i18n-parity.mjs --fix    # 打印需要补的 key(不自动改)
 *
 * 以 en 为基准。other 语言必须包含 en 的所有 key,不能多不能少。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'client', 'src', 'locales');

const EXPECTED_LANGS = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR', 'it', 'ru', 'tr'];

/** 递归收集 JSON 对象的所有 leaf key(dot notation)。 */
function collectKeys(obj, prefix = '') {
  const keys = new Set();
  for (const [k, v] of Object.entries(obj ?? {})) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sub of collectKeys(v, full)) keys.add(sub);
    } else {
      keys.add(full);
    }
  }
  return keys;
}

function diff(a, b) {
  const onlyA = [...a].filter(k => !b.has(k)).sort();
  const onlyB = [...b].filter(k => !a.has(k)).sort();
  return { onlyA, onlyB };
}

// 收集 en 下所有命名空间
const enDir = path.join(LOCALES_DIR, 'en');
const namespaces = fs.readdirSync(enDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''));

let hasIssues = false;

for (const ns of namespaces) {
  const enPath = path.join(LOCALES_DIR, 'en', `${ns}.json`);
  const enObj = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  const enKeys = collectKeys(enObj);

  for (const lang of EXPECTED_LANGS) {
    if (lang === 'en') continue;
    const langPath = path.join(LOCALES_DIR, lang, `${ns}.json`);
    if (!fs.existsSync(langPath)) {
      console.error(`❌ [${lang}] missing namespace: ${ns}.json`);
      hasIssues = true;
      continue;
    }
    const langObj = JSON.parse(fs.readFileSync(langPath, 'utf8'));
    const langKeys = collectKeys(langObj);

    const { onlyA: missingInLang, onlyB: extraInLang } = diff(enKeys, langKeys);
    if (missingInLang.length > 0 || extraInLang.length > 0) {
      hasIssues = true;
      console.error(`\n❌ [${lang}/${ns}]`);
      if (missingInLang.length) console.error(`   missing vs en: ${missingInLang.join(', ')}`);
      if (extraInLang.length) console.error(`   extra vs en:   ${extraInLang.join(', ')}`);
    }
  }
}

if (hasIssues) {
  console.error('\ni18n parity check failed. See diffs above.');
  process.exit(1);
}

console.log(`✓ i18n parity OK (${EXPECTED_LANGS.length} langs × ${namespaces.length} namespaces)`);
