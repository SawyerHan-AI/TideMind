# TideMind 安全配置 — Deployment-time 启用清单

代码层的安全机制已就位,但部分需要在 deployment 时配置密钥/参数才能真正工作。这份文档集中列出**所有需要运维启用的安全项 + step-by-step 启用步骤**。

最后更新: 2026-05-19

---

## 1. Release Manifest 离线签名(强烈建议启用)

### 风险
GitHub release 没有签名 → 任何能写 `SawyerHan-AI/TideMind` 仓库的人(GH_TOKEN 泄漏 / 账号被盗 / GitHub Actions 中毒)可推恶意 DMG 给全量客户端。

### 代码层状态
- 客户端验签: `client/electron/ipc/app.ts::verifyUpdateSignature` ✓
- 云端下发签名: `pro/cloud-server/src/update/routes.ts::findSignatureAsset` ✓
- 发版签名: `scripts/release.mjs::signReleaseAssets` ✓
- 缺密钥时强制 `--allow-unsigned` 显式确认 ✓

### 启用步骤(5 分钟,只需做一次)

**Step 1: 生成 ed25519 keypair**(在你的开发 Mac 本地)
```bash
node -e "
const c = require('crypto');
const { publicKey, privateKey } = c.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { format: 'pem', type: 'spki' },
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
});
console.log('=== PUBLIC KEY (embed in client/electron/ipc/app.ts) ===');
console.log(publicKey);
console.log('=== PRIVATE KEY (store in 1Password, NEVER commit) ===');
console.log(privateKey);
"
```

**Step 2: 私钥保管**
- 把 `=== PRIVATE KEY ===` 那段复制到 1Password / YubiKey
- **绝对不要** commit 到任何 git 仓库
- **不要** 存进 GitHub Actions secret(会和 GH_TOKEN 形成同一信任域,泄漏一个等于泄漏两个)

**Step 3: 公钥嵌入客户端**
编辑 `client/electron/ipc/app.ts`,找到:
```ts
const UPDATE_PUBLIC_KEY_PEM = process.env.TIDEMIND_UPDATE_PUBLIC_KEY ?? ''
```
改成:
```ts
const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
<把 Step 1 输出的 PUBLIC KEY 内容贴这里,保留换行>
-----END PUBLIC KEY-----
`
```

**Step 4: 发版时注入私钥**
```bash
SIGNING_PRIVATE_KEY="$(cat 私钥路径.pem)" npm run release -- --version 0.2.62
```
或者从 1Password CLI:
```bash
SIGNING_PRIVATE_KEY="$(op read 'op://Private/TideMind Signing/private-key')" npm run release -- --version 0.2.62
```

### 启用后行为
- `signReleaseAssets` 会对每个平台 DMG 签名,上传 `update-manifest-{platform}-{arch}.sig` 到 release
- 新版客户端 `/api/v1/update/latest` 返回时带 `signatureUrl`
- 客户端拿到后用内置公钥验 `${version}\n${url}` 的 ed25519 签名,失败拒更新

### 应急流程

**私钥泄漏怎么办?**
1. 立即用 Step 1 生成新 keypair
2. 客户端要支持"主公钥 + 备用公钥"双签名验证(当前实现只支持单 key,**长期 TODO**)
3. 发新版客户端嵌入新公钥
4. 等存量用户全部升级后,新 release 才能切到新 key

**当前单 key 限制**: 第一次密钥泄漏需要把所有用户挡在旧 release(或者临时回退到无签名模式)。所以**密钥保管比代码实现更重要**。

---

## 2. Cloud Strategy 上云同步(默认已启用)

### 状态
代码已就位,启用条件:
- 客户端: `config.cloud.sync_enabled = true` 且用户已登录
- 云端: migration 016 已包含 `user_strategies` 表 + RLS policy

### 验证启用
```bash
# 编辑客户端 prompt 后检查云端是否收到:
curl -H "Authorization: Bearer $TOKEN" https://cloud.tidemind.ai/auth/me
# 然后云端代谢任务下次跑时会用你自定义的 prompt
```

### 默认行为
- 用户没自定义 → 云端用 hardcoded fallback(与 `data/strategies/*.system.md` 字符一致)
- 用户自定义后 → silent push 到云端 → 云端代谢用用户版本

---

## 3. Cloud Whitelist(默认已启用)

`CLOUD_WHITELIST` env(逗号分隔 user_id)未设时,云端 feature 对所有用户开放。私测期可设:
```bash
CLOUD_WHITELIST=usr_abc,usr_def
```

---

## 4. Webhook Signing Enforcement(默认已启用)

`WEBHOOK_SIG_ENFORCE` 默认 `true`。LemonSqueezy webhook 必须带合法签名才被处理。生产环境保持 `true`。

---

## 5. Admin Auth(必须配置)

`ADMIN_TOKEN` env 未设时 admin endpoint 拒绝所有请求。生产必须设置一个 32+ 字符随机值。

---

## 6. JWT Secret(必须配置)

`JWT_SECRET` env 必须设置 ≥32 字符强随机值。未设时 cloud-server 启动失败。

---

## 完整 deployment env 清单(生产)

```bash
# 必须
DATABASE_URL=postgres://...
JWT_SECRET=$(openssl rand -base64 48)
ADMIN_TOKEN=$(openssl rand -base64 32)
WEBHOOK_USER_ID_SECRET=$(openssl rand -base64 32)

# 推荐
LEMONSQUEEZY_WEBHOOK_SECRET=...
GH_TOKEN=...                       # 拉 release manifest 用
CLOUD_WHITELIST=usr_abc,usr_def    # 私测期

# 启用 release signing(详见 §1)
# 公钥嵌入客户端代码,私钥仅发版机器使用
```

## 完整 deployment env 清单(发版机器)

```bash
SIGNING_PRIVATE_KEY="$(op read 'op://Private/TideMind Signing/private-key')"
```

---

**任何字段缺失都会让对应安全机制 silent 跳过 + log warn。代码不会拒绝启动,但保护层会失效——所以这份文档是 deployment checklist 而非可选参考。**
