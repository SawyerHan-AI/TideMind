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

### 应急流程(双 key 平滑轮换,v0.2.64 起支持)

**私钥泄漏怎么办?** 客户端 `UPDATE_PUBLIC_KEY_PEM_SECONDARY` 默认空,**当其填入时启用双 key 验证**:主或次公钥任一通过即接受签名。

```
轮换流程(总时长由"用户升级速度"决定,通常 1~2 个月):

阶段 1(当天):
  1) 生成新 ed25519 keypair
       node scripts/gen-signing-keypair.mjs
  2) 把"新公钥"填入 client/electron/ipc/app.ts::UPDATE_PUBLIC_KEY_PEM_SECONDARY
     主公钥 UPDATE_PUBLIC_KEY_PEM 暂时保留(老 release 仍用旧私钥签的 .sig)
  3) 立即发版 vX.Y.Z(用旧主私钥签 .sig)→ 客户端含新 secondary 公钥但不会用到
  4) 把"新私钥"存到 Keychain 的 secondary 槽:
       security add-generic-password -U \
         -a tidemind -s tidemind-signing-key-secondary -w "$(pbpaste)"
     (先从 1Password 复制新私钥到 clipboard)

阶段 2(等用户升级,1~4 周):
  发版正常进行,继续用旧主私钥签 .sig。版本号叠加直到大部分用户升到含新 secondary
  公钥的版本(通过 update API 的 version 字段统计)。

阶段 3(切换):
  5) 发版时设 SIGNING_PRIVATE_KEY_SECONDARY 指向"旧"私钥,
     SIGNING_PRIVATE_KEY 指向"新"私钥 → 同时上传 .sig(新私钥签) + .sig.secondary(旧私钥签)
     老客户端用旧公钥验 .sig.secondary,新客户端用新公钥验 .sig
  6) 跑几个版本观察日志,确认所有客户端都能正常验签

阶段 4(完成轮换):
  7) 下一版本:把 UPDATE_PUBLIC_KEY_PEM 改成"新公钥",
     UPDATE_PUBLIC_KEY_PEM_SECONDARY 清空
  8) release.mjs 改为只用 SIGNING_PRIVATE_KEY(新私钥)单签
  9) 旧私钥可销毁,旧公钥从 Keychain secondary 槽删除

代码:client/electron/ipc/app.ts:verifyWithEitherKey + pro/cloud-server/src/update/routes.ts:findSecondarySignatureAsset
单测:tests/client/update-signature.test.ts (10 cases 覆盖主/次/组合验证)
```

**密钥保管仍然比代码实现更重要** — 双 key 只是把"立即停服"延后为"等用户升级再切"。私钥本身泄漏后,攻击者依然能签任何 release,直到主公钥被替换。

### 当前签名 payload 的威胁模型 + 取舍说明(2026-05-20 加入)

**签名内容**:`${version}\n${url}`(ed25519 over UTF-8 bytes)。**不包含 DMG 文件内容的 sha512**。

**这能防什么**:
- 攻击者拿到 cloud-server 写权限,伪造 manifest 返回任意 `version` / `url` —— 签名验证失败,客户端拒绝。
- 攻击者用旧 `.sig` 回放更早版本的 manifest —— 客户端的 `compareSemver` downgrade guard 拦截(verifier.ts L67-71)。
- 攻击者只控制 DNS / CDN —— 签名校验在客户端用内置公钥本地完成,不依赖 TLS。

**这不能防**:**GitHub Release assets 被替换字节**。当前 binary 完整性是由 `electron-updater` 用 `latest-mac.yml` 里的 `sha512` 字段校验的,但 **`latest-mac.yml` 本身没有 ed25519 签名**。攻击拓扑:
1. 攻击者拿到 `SawyerHan-AI/TideMind` 写权限
2. 把 v0.2.X 的 DMG 字节替换为恶意版本
3. 重算 sha512 写回 `latest-mac.yml`
4. URL 没变,我们的 `.sig` 仍验证通过 → 客户端按"URL 是 0.2.X"的 manifest 下载 → electron-updater 用篡改的 sha512 校验 → 通过 → 用户装上恶意版本

**当前的取舍**:接受这个威胁,**不**把签名 payload 扩到覆盖 sha512。理由:
1. **威胁概率**:GitHub 写权限事故远低于"中间人换 URL 转账户"事故。GH_TOKEN + 2FA + branch protection + Actions 权限隔离比签名扩 sha512 更先该做。
2. **改造成本**:扩 payload 需要客户端和服务端同步升级,旧客户端会因 sig 不匹配进 `invalid`。需要"双签"过渡(同时上传 `${v}\n${u}` 和 `${v}\n${u}\n${sha}` 两套 .sig),持续 1-2 个版本周期,~2 天工作量。
3. **GH 真被入侵的话救不了多少**:攻击者既能改 DMG,也能改 `client/electron/ipc/app.ts` 里的内置公钥本身,签名扩 sha512 防御就失效了。供应链层面的攻击需要 SLSA provenance / sigstore transparency log 这类公开审计机制才能真防。
4. **可观测性兜底**:客户端 `verifyUpdateSignature` 现在区分 `verified | unsigned | invalid | unreachable`(2026-05-20 D-3 修),`invalid` 状态在客户端日志显式标记,且 update API 是从 `cloud.tidemind.ai` 受控端点拉的(不是直接 GitHub),万一 GitHub 被入侵 cloud-server 可以紧急拒绝下发恶意 release(把 mandatory=false + URL 改成空 → 客户端不下载)。

**重新评估的触发条件**:
- 拿到 100+ 用户,或商业敏感数据上云,值得花 2 天做 SLSA provenance
- 出现真实的 GH 入侵事故(行业平均 1-2 年一次)
- 接入第三方依赖的 release 流程(增加供应链节点)



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

## 7. Neon Compute 配额监控(必须配置告警)

### 风险

Neon Postgres Free 套餐每月 100 CU-hr,Pro 套餐有更高但仍有上限。配额耗尽 → endpoint
被强制 suspend → cloud-server 启动时 `getSql()` 抛错 → Railway 进入 crash-loop。

**实际事故**: 2026-05-10 Free 配额耗尽,cloud.tidemind.ai crash-loop **5 天才被发现**
(因为没人监控)。修复方法:升级到 Pro + 重新部署 + 加告警。

### 代码层状态

- cloud-server 无 Neon 配额监控代码 — 配额监控由 **Neon 控制台原生告警** 完成,不在
  应用层做。原因:任何"自动告警脚本"都需要 NEON_API_KEY,放 Railway env 就把生产
  DB 读权限给了运行环境。Neon 控制台告警走他们的可信通道,不需要把 key 暴露给应用。

### 启用步骤(5 分钟,只需做一次)

#### Step 1 — 在 Neon 控制台配告警

1. 登录 https://console.neon.tech,选 TideMind 项目
2. **Settings** → **Usage alerts**(或 **Billing** → **Usage notifications**,UI 在改版)
3. 配两个阈值:
   - **80% 阈值** → 邮件告警(让你有时间扩容 / 切换套餐)
   - **100% 阈值** → 邮件告警 + 触发 endpoint suspend(防止意外超支)
4. 接收邮箱填本人邮箱(同 Neon 账号)
5. 确认收到 Neon 的"alerts configured"测试邮件

#### Step 2 — 验证 endpoint suspend 行为

Free 套餐撞 100% 后 endpoint 会被 suspend。Pro/Scale 套餐撞 100% 通常按超量收费不
suspend,但仍然建议设阈值告警避免账单意外。

#### Step 3 — Railway 端配 dependency health check(可选)

如果 cloud-server 启动失败也想告警,可以在 Railway 加 deploy alert:
- **Settings** → **Notifications** → 配 deploy failed → Email/Discord webhook

### 排查

- **症状: cloud.tidemind.ai 502 / health check timeout** → 第一步检查 Neon 控制台
  是否有 "Endpoint suspended due to compute quota exceeded" 横幅
- **症状: Railway 日志 `error: connection terminated unexpectedly` 反复** → 同上,
  Neon endpoint 被 suspend 后 connection 拿不到
- **修复**: Neon 控制台 → Project → Compute → Resume endpoint(Free 用户需先升级套餐
  才能 Resume)

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
