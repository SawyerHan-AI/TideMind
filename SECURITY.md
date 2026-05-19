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

**Step 4: 私钥存到 macOS Keychain(推荐,一次配置永久使用)**
```bash
# 先从 1Password 复制私钥(整段 PEM)到 clipboard,然后:
security add-generic-password -U -a tidemind -s tidemind-signing-key -w "$(pbpaste)"
pbcopy < /dev/null   # 立刻清空 clipboard
# 之后所有 npm run release 自动从 Keychain 取私钥,无需任何 env
```

第一次访问 Keychain 时会弹 Touch ID 或 Master Password 确认,可勾选"始终允许"减少摩擦。Keychain 由 macOS 系统保护(FileVault + Secure Enclave),比 env 或临时文件更稳。

**或者一次性注入 env**(适合 CI / 不想配 Keychain):
```bash
SIGNING_PRIVATE_KEY="$(cat ~/key.tmp.pem)" npm run release -- --version 0.2.62
# 跑完 unset SIGNING_PRIVATE_KEY
```

**release.mjs 取私钥顺序**:env → Keychain → fail-loud(除非 `--allow-unsigned`)

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

## 1B. Apple Code Signing + Notarization(强烈建议启用)

### 风险
DMG 未签名时,用户下载装 app 会弹"无法打开,因为它来自身份不明的开发者",
需要手动右键打开绕过 Gatekeeper。装机率显著下降。

### 代码层状态
- `client/electron-builder.yml::mac` 已配置:
  - `hardenedRuntime: true` ✓
  - `notarize: true` ✓
  - `entitlements: resources/entitlements.mac.plist` ✓
  - `gatekeeperAssess: false` ✓(GitHub runner 上不验,等用户机器装时验)
- `.github/workflows/release.yml` 已注入 5 个 secrets 到 env
- 5 个 GitHub Secrets 未设时 electron-builder 自动跳过签名(等于今天行为,向后兼容)

### 启用步骤(30 分钟,一次性)

需要你**有效的 Apple Developer Program 账号**($99/年)。

**Step 1: Apple Developer Portal 配置**
1. 访问 https://developer.apple.com/account
2. **Certificates, IDs & Profiles** → **Identifiers** → **+** → **App IDs** → 类型 **App**
3. 填写:
   - Description: `Tide Mind`
   - Bundle ID:**Explicit**,值 `com.tidemind.app`(必须与 `client/electron-builder.yml::appId` 完全一致)
   - 不需要勾任何 Capabilities(Electron app 用 entitlements 而非 capabilities)
4. **Register**

**Step 2: Developer ID Application 证书**
1. 在 **Certificates** 标签 → **+** → 类型 **Developer ID Application**(注意是这个,**不是** Mac App Distribution)
2. 在你 Mac 上 **钥匙串访问 → 证书助理 → 从证书颁发机构请求证书** 生成 CSR 文件
3. 上传 CSR → 下载 .cer 证书 → 双击导入钥匙串
4. 在 **钥匙串访问** 里找到这个证书(名字类似 "Developer ID Application: Your Name (ABCDE12345)")
5. 右键 → **导出**,选 **.p12 格式**,设一个密码并记住(下一步用)
6. **转 base64**(macOS 自带 openssl 是 LibreSSL,**不支持 `-i` flag**,要用 `-in` 或系统 base64):
   ```bash
   base64 -i ~/Downloads/TideMind.p12 | tr -d '\n' | pbcopy
   # 或:
   openssl base64 -A -in ~/Downloads/TideMind.p12 | pbcopy
   ```
   pbcopy 把 base64 字符串(无换行)复制到 clipboard,下一步粘到 GitHub Secret。

**Step 3: App-Specific Password**
1. 访问 https://account.apple.com → 登录
2. **登录与安全** → **App 专用密码** → **+** → 标签 `TideMind notarization`
3. 复制生成的密码(格式 `xxxx-xxxx-xxxx-xxxx`,只显示一次)

**Step 4: Team ID**
1. https://developer.apple.com/account → 顶部 **Membership details**
2. 复制 **Team ID**(10 字符,如 `ABCDE12345`)

**Step 5: 在 GitHub Repo Settings 设 5 个 Secrets**

访问 `https://github.com/SawyerHan-AI/TideMind/settings/secrets/actions` → **New repository secret**,创建以下 5 个:

| Secret 名 | 值来源 |
|---|---|
| `MAC_CERTIFICATE` | Step 2 第 6 步 `openssl base64` 的输出(整段 base64 字符串) |
| `MAC_CERTIFICATE_PASSWORD` | Step 2 第 5 步导出 .p12 时设的密码 |
| `APPLE_ID` | 你的 Apple Developer 账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Step 3 生成的 `xxxx-xxxx-xxxx-xxxx` |
| `APPLE_TEAM_ID` | Step 4 的 10 字符 Team ID |

**Step 6: 销毁本地敏感文件**
```bash
rm -P ~/Downloads/TideMind.p12   # macOS 安全删除(覆盖后删)
pbcopy < /dev/null                # 清 clipboard
# .cer 文件保留(公开信息) / 钥匙串里的证书保留(以后可以再导出 .p12)
```

### 启用后行为
- 下次 `npm run release` 触发 GitHub Actions Release workflow:
  - electron-builder 检测到 secrets 已设 → 签名 + 公证
  - 公证耗时 ~2-5 分钟(Apple 服务器审核 + stapler 写票据回 DMG)
  - 整个 build-mac job 从 ~3 分钟变成 ~6-8 分钟
- 用户下载 DMG → 双击安装 → 不再弹"身份不明开发者"警告

### 排查
- **build 失败 "no identity found"** → MAC_CERTIFICATE secret 没设或 base64 错(用 `base64 -i FILE | tr -d '\n'` 或 `openssl base64 -A -in FILE` 去掉换行)
- **notarize 失败 "Invalid credentials"** → APPLE_ID / APP_SPECIFIC_PASSWORD / TEAM_ID 任一错
- **notarize 失败 "The signature does not include a secure timestamp"** → entitlements.mac.plist 漏了关键 key,看 client/resources/entitlements.mac.plist 是否完整
- **notarize timeout > 30 分钟** → Apple 服务器排队中,通常自动恢复;实在不行 `xcrun notarytool log <submission-id>` 看具体原因

### 证书过期
- Developer ID Application 证书有效期 **5 年**
- 过期前 3 个月内重做 Step 2(钥匙串里旧证书不删,加新的并列即可)
- 然后更新 MAC_CERTIFICATE secret(用新 .p12 重做 Step 2 第 6 步)

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
