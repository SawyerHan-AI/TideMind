#!/usr/bin/env node
/**
 * 一次性密钥生成脚本 — 给 TideMind release manifest 签名用。
 *
 * 用法:
 *   node scripts/gen-signing-keypair.mjs
 *
 * 输出 ed25519 keypair(PEM 格式):
 *   - PUBLIC KEY → 复制给 Claude,嵌入 client/electron/ipc/app.ts
 *   - PRIVATE KEY → 存进 1Password,绝不 commit / 绝不外发
 *
 * 安全:
 *   - 私钥用 stdout 输出,跑完后立即把这个文件**关闭**,清空终端历史
 *   - 不要把私钥贴回任何对话窗口
 */

import crypto from 'node:crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { format: 'pem', type: 'spki' },
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
});

console.log('================== PUBLIC KEY ==================');
console.log('(整段复制给 Claude,包括 BEGIN/END 两行)');
console.log('');
console.log(publicKey);
console.log('================== PRIVATE KEY =================');
console.log('(整段存进 1Password — 条目名建议 "TideMind Release Signing")');
console.log('(绝不要 commit / 绝不要贴回对话框)');
console.log('');
console.log(privateKey);
console.log('================================================');
console.log('记得清终端历史: history -c (bash) / fc -p (zsh)');
