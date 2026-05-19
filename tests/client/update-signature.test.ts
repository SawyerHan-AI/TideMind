/**
 * Update signature verification — 双 key 轮换支持(2026-05-19)
 *
 * 测试 verifyWithPublicKey + verifyWithEitherKey 的纯函数行为。完整 fetch 路径
 * (verifyUpdateSignature)涉及网络 mock,这里只覆盖密码学决策层。
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { verifyWithPublicKey, verifyWithEitherKey } from '../../client/electron/ipc/app';

function genKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey,
  };
}

function sign(privateKey: crypto.KeyObject, msg: string): Buffer {
  return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey);
}

describe('verifyWithPublicKey', () => {
  it('正确签名 + 正确公钥 → true', () => {
    const { pub, priv } = genKeyPair();
    const msg = '0.2.64\nhttps://example/dmg';
    const sig = sign(priv, msg);
    expect(verifyWithPublicKey(pub, Buffer.from(msg, 'utf8'), sig)).toBe(true);
  });

  it('正确签名 + 错误公钥 → false', () => {
    const { priv } = genKeyPair();
    const { pub: wrongPub } = genKeyPair();
    const msg = '0.2.64\nhttps://example/dmg';
    const sig = sign(priv, msg);
    expect(verifyWithPublicKey(wrongPub, Buffer.from(msg, 'utf8'), sig)).toBe(false);
  });

  it('篡改 message → false', () => {
    const { pub, priv } = genKeyPair();
    const sig = sign(priv, '0.2.64\nhttps://example/dmg');
    const tamperedMsg = Buffer.from('0.2.64\nhttps://malicious/dmg', 'utf8');
    expect(verifyWithPublicKey(pub, tamperedMsg, sig)).toBe(false);
  });

  it('损坏的 PEM → false(不抛)', () => {
    const sig = Buffer.from([0, 0, 0]);
    expect(verifyWithPublicKey('-----BEGIN garbage-----', Buffer.from('x'), sig)).toBe(false);
  });
});

describe('verifyWithEitherKey (双 key 轮换)', () => {
  it('主签名通过 → true', () => {
    const { pub: primary, priv: primaryPriv } = genKeyPair();
    const { pub: secondary } = genKeyPair();
    const msg = Buffer.from('0.2.64\nhttps://example/dmg', 'utf8');
    const sig = sign(primaryPriv, msg.toString('utf8'));
    expect(verifyWithEitherKey(primary, secondary, msg, sig)).toBe(true);
  });

  it('主签名失败 + 次签名通过 → true (轮换关键场景)', () => {
    const { pub: primary } = genKeyPair();
    const { pub: secondary, priv: secondaryPriv } = genKeyPair();
    const msg = Buffer.from('0.2.64\nhttps://example/dmg', 'utf8');
    // 用 secondary 私钥签
    const sig = sign(secondaryPriv, msg.toString('utf8'));
    expect(verifyWithEitherKey(primary, secondary, msg, sig)).toBe(true);
  });

  it('主签名失败 + 次签名也失败 → false', () => {
    const { pub: primary } = genKeyPair();
    const { pub: secondary } = genKeyPair();
    const { priv: malicious } = genKeyPair();
    const msg = Buffer.from('0.2.64\nhttps://example/dmg', 'utf8');
    const sig = sign(malicious, msg.toString('utf8'));
    expect(verifyWithEitherKey(primary, secondary, msg, sig)).toBe(false);
  });

  it('secondary 为空字符串 → 仅主公钥验证(默认行为兼容)', () => {
    const { pub: primary, priv: primaryPriv } = genKeyPair();
    const msg = Buffer.from('0.2.64\nhttps://example/dmg', 'utf8');
    const sig = sign(primaryPriv, msg.toString('utf8'));
    expect(verifyWithEitherKey(primary, '', msg, sig)).toBe(true);
  });

  it('secondary 为空 + 主验证失败 → false (不要 fall through 到 secondary)', () => {
    const { pub: primary } = genKeyPair();
    const { priv: malicious } = genKeyPair();
    const msg = Buffer.from('0.2.64\nhttps://example/dmg', 'utf8');
    const sig = sign(malicious, msg.toString('utf8'));
    expect(verifyWithEitherKey(primary, '', msg, sig)).toBe(false);
  });

  it('双 key 验证不受公钥顺序影响 (主备对调仍能通过)', () => {
    const { pub: keyA, priv: privA } = genKeyPair();
    const { pub: keyB, priv: privB } = genKeyPair();
    const msg = Buffer.from('m', 'utf8');
    // A 签名 + (主=A, 备=B) → 通过
    expect(verifyWithEitherKey(keyA, keyB, msg, sign(privA, 'm'))).toBe(true);
    // B 签名 + (主=A, 备=B) → 通过(走 secondary 路径)
    expect(verifyWithEitherKey(keyA, keyB, msg, sign(privB, 'm'))).toBe(true);
    // A 签名 + (主=B, 备=A) → 通过(走 secondary 路径)
    expect(verifyWithEitherKey(keyB, keyA, msg, sign(privA, 'm'))).toBe(true);
  });
});
