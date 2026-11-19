# dsh-archiver

把 DSH 里的**每一个技能**、**每一个插件**各自打成一个 zip，落到本地指定目录，可选再同步到 WebDAV。
三种触发：**设置页 / 工具 / 命令行手动**、**定时**（每 N 小时 / 每天 HH:MM）、**DSH 启动后自动**。
导出的备份可以用同一个插件**一键导入回来**（技能直接进技能根，插件解到导入目录并给出 link 命令）。

- 设置页：`设置 → 归档备份`，自动模式与手动模式分开配置，带状态卡、产物列表、日志
- 零依赖：zip 写入器自带（`node:zlib` deflate），不 import 任何第三方包
- 原子写：先 `.tmp` 再 rename；单项失败不影响整体，失败会如实计入结果
- 可校验：每个包都有 sha256，`manifest.json` 记录来源、大小、文件数、耗时
- 增量：源目录没变就复用上次的 zip（可选）
- 历史版本：保留最近 N 份快照，只删自己写的目录，别人的同名目录一律不碰

> 这里不放截图：面板截图很容易把会话列表等私人信息一起截进去，想看效果请在自己机器上打开
> `设置 → 归档备份`。

---

## 0. 从 GitHub 安装

```powershell
dsh plugin --profile desktop add github:chiya695/dsh-archiver
```

也可以直接给出仓库链接（等价写法）：

```powershell
dsh plugin --profile desktop add https://github.com/chiya695/dsh-archiver
```

装完**完全退出 DSH（托盘退出）再启动**：宿主侧的定时器与工具、浏览器侧的设置页都要在启动时装载。
卸载：`dsh plugin --profile desktop remove dsh-archiver`。

---

## 1. 从本地目录装上（开发用）

把仓库放到任意目录（下文称 `<插件目录>`），然后：

```powershell
dsh plugin --profile desktop add link:<插件目录>
```

`dsh plugin add` 会同时把包名写进 profile 的 `dsh.profile.bundles`。装完同样要重启。

> 手工挂的等价做法：在 `profiles/<name>/node_modules` 下建 junction 指向本目录，
> 再把包名加进 `package.json` 的 `dependencies`（`link:` 形式）与 `dsh.profile.bundles`。

---

## 2. 设置页（设置 → 归档备份）

点任何按钮（归档 / 测试 WebDAV / 保存设置）之后，**结论出现在面板顶部的大横幅**：绿=成功、红=没成功，
并带「原因 + 具体怎么办 + 落点」，不用翻日志；关掉面板再打开还会显示「上次 WebDAV 自检」的结论。

**手动归档按"落到哪儿"分三个按钮**，不用猜：

| 按钮 | 发送的 `dest` | 落点（横幅里会逐行写明） |
|---|---|---|
| 归档到本地（保存目录） | `local` | `本地写入 N 个 → <保存目录>` |
| 归档到云端（WebDAV） | `webdav` | `云端上传 N 个 → <远端地址>` |
| 本地 + 云端 | `both` | 两行都给 |

卡片里同时显示当前的本地目录与云端目录。**目标不成立时明确拒绝**：点「归档到云端」但 WebDAV 没启用 / 没地址，
服务端直接返回 `WEBDAV_NOT_CONFIGURED`，横幅红字写明「所以没有执行（也没有偷偷只存本地）」，并指向 WebDAV 分组。
勾了「空跑」则只扫描打包，不写盘也不上传（云端按钮会显示"空跑，没有上传"）。

一页分成四块：

1. **概览**：可归档数量（技能/插件）、本地产物数量与体积、上次运行、**下次自动归档时间**、WebDAV 状态、
   保存目录；三个按钮直接打开保存目录 / 日志 / 配置文件。
2. **立即归档（手动）**：归档对象（技能+插件 / 只技能 / 只插件）、空跑、三个目标按钮、测试 WebDAV。
   这里的选择**只作用于这一次**；自动归档用「默认落地位置」（在「模式与对象」里）。
3. **设置分组**：模式与对象 / 自动模式 / 手动模式 / 本地落地 / WebDAV / 打包 / 来源。
   改完点底部「保存 N 项修改」——只提交改动过的字段，保存后定时器立刻按新值算，不用重启。
4. **本地产物 + 运行日志**：产物清单（大小 / 时间）与最近 80 行日志。

字段由 `lib/schema.mjs` 描述，页面按类型渲染——加设置项只改那个文件，前端不动。

### 自动模式

| 设置项 | 键 | 默认 | 说明 |
|---|---|---|---|
| DSH 启动后自动归档一次 | `auto.onStart` | 开 | 每次启动（含重启）跑一次 |
| 启动后延迟 | `auto.onStartDelayMs` | 15000 ms | 别跟启动读盘抢 IO |
| 每隔几小时自动归档 | `auto.everyHours` | 24 | `0` = 关闭这条节拍 |
| 每天定时 | `auto.dailyAt` | 空 | 本地时间 `HH:MM`；当天跑过不重复 |
| 最小间隔 | `auto.minGapMinutes` | 30 | 防抖：刚跑过（含手动）不会立刻再跑 |

两条节拍可以同时开，谁先到点谁触发；`enabled` 关掉只停自动，手动照常。

### 手动模式

| 设置项 | 键 | 默认 | 说明 |
|---|---|---|---|
| 默认归档对象 | `manual.defaultTargets` | 全部 | 面板 / 工具 / CLI 省略参数时用它 |
| 默认空跑 | `manual.dryRun` | 关 | 只扫描打包、不写盘不上传 |
| 跑完自动打开产物目录 | `manual.openAfterRun` | 关 | 仅本地落地 |

### 其它分组

- **模式与对象**：`enabled`、`targets.skills`、`targets.plugins`、`dest`（local/webdav/both）、`zip.skipUnchanged`
- **本地落地**：`local.root`、`local.layout`（flat/run）、`local.keepRuns`
- **WebDAV**：`webdav.enabled`、`url`、`username`、`password`、`passwordEnv`、`root`、`timeoutMs`
- **打包**：`zip.level`、`zip.maxFileMB`、`zip.exclude`（一行一个）
- **来源**：`sources.projectCwd`、`sources.extraSkillRoots`、`includeBuiltinPlugins`、`includeBundledSkills`、`includeAgentsSkills`

---

## 3. 触发方式

| 入口 | 用法 |
|---|---|
| 设置页 | 上面那块「立即归档」 |
| 工具 | `dsh_archive_now` / `dsh_archive_status` / `dsh_archive_config` |
| 命令行 | `node bin\dsh-archiver.mjs run --dest both`、`status --details`、`config set …`、`test-webdav` |
| HTTP | `GET/POST /api/dsh-archiver`（`?view=boot|status|logs`，`{"action":"run|config|test-webdav|open|prune"}`） |
| 自动 | `auto.*` 三个节拍 + `enabled` 总开关 |

工具参数省略时的默认值来自 `manual.*`，单次仍可临时覆盖：

```text
dsh_archive_now { targets: "skills", dryRun: true }     # 只看会打哪些
dsh_archive_now { dest: "both" }                        # 这次顺手传到 WebDAV
```

---

## 4. 配置

真相源：`$DSH_HOME/dsh-archiver/config.json`（Windows 上一般是
`C:\Users\<你的用户名>\.dsh\dsh-archiver\config.json`）。
三种改法：设置页、`dsh_archive_config` 工具、`node bin\dsh-archiver.mjs config set <key> <value>`。
所有值都会过一遍规范化（乱填的负数 / 字符串被钳回合法范围）；设置页只接受 `lib/schema.mjs` 登记过的键。

```jsonc
{
  "enabled": true,
  "targets": { "skills": true, "plugins": true },
  "dest": "local",                       // local | webdav | both

  "local": { "root": "", "layout": "flat", "keepVersions": 0, "pluginImportDir": "" },   // root 空 = $DSH_HOME/dsh-archiver/out

  "webdav": {
    "enabled": false,
    "url": "https://dav.jianguoyun.com/dav/",
    "username": "you@example.com",
    "password": "",                      // 建议留空
    "passwordEnv": "DSH_ARCHIVER_WEBDAV_PASSWORD",
    "root": "dsh-archiver",
    "timeoutMs": 60000
  },

  "auto":   { "onStart": true, "onStartDelayMs": 15000, "everyHours": 24, "dailyAt": "", "minGapMinutes": 30 },
  "manual": { "defaultTargets": "all", "dryRun": false, "openAfterRun": false },

  "zip": {
    "level": 6,
    "maxFileMB": 64,
    "skipUnchanged": false,              // 增量：源没变就复用上次的 zip
    "exclude": ["node_modules", ".git", ".pnpm", ".turbo", ".cache", ".DS_Store", "Thumbs.db"]
  },

  "sources": {
    "projectCwd": "",
    "extraSkillRoots": [],
    "includeBuiltinPlugins": false,      // true = 连 @deepseek-ai/* 基础包也各打一包
    "includeBundledSkills": true,        // office-docx/pptx/xlsx
    "includeAgentsSkills": true          // ~/.agents/skills
  }
}
```

### 历史版本（保留 N 份）

设置项：**本地落地 → 保留历史版本数量**（`local.keepVersions`，0 = 只留最新）。

- `flat` 布局：最新永远在那几个固定文件名上，另外每轮往 `<保存目录>/history/<YYYYMMDD-HHmmss>/` 存一份快照；
- `run` 布局：`<保存目录>/<时间戳>/` 本身就是快照，N 决定**保留几份**，超出自动删最旧的；
- 面板「历史版本」卡片会列出每份快照（时间 / 包数 / 体积），可以 **打开历史目录**、**清理到 N 份**、
  或直接 **导入这份**（把该快照填进导入来源并扫描）。

磁盘占用 ≈ N × 单轮体积（这台机器一轮约 17.9 MB，N=10 就是 ~180 MB）。
`run` 布局且 N=0 时面板会黄字提醒"不会自动清理"；`dest` 设成「只传 WebDAV」时本地不落盘，
历史版本也就无从谈起，面板同样会黄字说明。

> 清理只删**本插件写的**快照：删之前会读该目录的 `manifest.json`，`tool` 不是 `dsh-archiver`
> （或压根没有 manifest）的目录一律跳过、不碰。所以你往保存目录里放自己的同名目录是安全的。

### 导入备份（吃自己导出的东西）

面板「导入备份」卡片，或工具 `dsh_archive_import`（`action=scan|import`）：

1. **来源**：导出根目录（`D:\Backup\dsh`，run 布局的根目录也行——会自动下钻一层时间戳目录）、
   某份历史快照目录、或单个 `.zip`；
2. **扫描**：列出每个包会落到哪、是否已存在（技能包 = 根目录有 `SKILL.md`；插件包 = 有 `package.json`；
   技能包哪怕也带 package.json 也算技能——archify 就是这种；**单文件技能**（裸 `.md`）也算技能）；
3. **勾选 + 导入**：
   - 技能 → `$DSH_HOME/skills/<名字>/`（默认；可在「来源 → 技能导入目录」改），DSH 会自动发现；
     单文件技能落成 `$DSH_HOME/skills/<名字>.md`；
   - 插件 → `$DSH_HOME/dsh-archiver/imported-plugins/<包名>/`（可在「本地落地 → 插件导入目录」改）；
   - 结果里给出 `dsh plugin --profile <当前> add link:<路径>`，**不替你改 profile / bundles**；
4. **覆盖**：勾上后旧的同名目录会改名成 `<名字>.bak-<时间戳>` 留底，不删除任何东西。

安全细节：zip 条目含 `..` / 绝对路径整体拒绝；**包名（package.json 的 name）也会被洗过**
（`../../evil` 这种只会落成 `evil`，且目标必须落在导入根内）；`NUL`/`CON` 这类 Windows 保留名在打包和导入两头都跳过
（它们能创建但删不掉，曾经把 `NUL` 打进过自己的包）。解压先落 `.importing-*` 临时目录，校验通过才改名。

### 只想手动跑（不需要自动）时怎么设

1. 「启用自动归档」关掉，或
2. 保留总开关，把 `auto.onStart` 关掉、`auto.everyHours` 设 0、`auto.dailyAt` 清空 ——
   效果一样，后者还能让概览里的「下次自动」显示成“不会再自动跑”
3. 想要“每 3 天跑一次”：`auto.everyHours = 72`

### WebDAV 密码

```powershell
setx DSH_ARCHIVER_WEBDAV_PASSWORD "你的应用密码"    # 新开终端 / 重启 DSH 后生效
node bin\dsh-archiver.mjs config set webdav.url "https://dav.jianguoyun.com/dav/"
node bin\dsh-archiver.mjs config set webdav.username "you@example.com"
node bin\dsh-archiver.mjs config set webdav.enabled true
node bin\dsh-archiver.mjs config set dest both
node bin\dsh-archiver.mjs test-webdav
```

坚果云要用**应用密码**（网页版 → 安全 → 第三方应用管理），不是登录密码。

> 面板与工具**都不回显**已存的密码（`/api/dsh-archiver?view=boot` 里 `webdav.password` 恒为空串，
> 只给 `hasPassword` / `passwordFromEnv`）。所以密码框留空 = 不修改；要清空请用命令行
> `node bin\dsh-archiver.mjs config set webdav.password ""`。

---

## 5. 产物长什么样

### flat（默认，稳定文件名）

```
$(saveRoot)/
  manifest.json
  skills/archify.zip  office-docx.zip  dsh-browser.zip  reverse-engineer-anything.zip
  plugins/dsh-purge.zip  dshmarket.zip  @michengai__dsh-skills-manager.zip  …
```

### run（每次一个时间戳目录，留历史）

```
$(saveRoot)/20261117-163155/{manifest.json, skills/…, plugins/…}
```

### 历史快照（flat + `keepVersions` > 0）

```
$(saveRoot)/history/20260101-030000/{manifest.json, skills/…, plugins/…}
$(saveRoot)/history/20260101-090000/{…}      # 只保留最近 N 份
```

zip 内部保留一层根目录，解压即用：`archify/SKILL.md`、`dsh-purge/package.json` …

`manifest.json` 的每项都带 `sourceSignature`（增量指纹）、`reused`（是否复用）、`sha256`、`files`、`bytes`、`zipBytes`、`warnings`。
核对：`Get-FileHash <zip> -Algorithm SHA256` 与 manifest 比对。

---

## 6. 它到底收了哪些东西

**技能**：`$DSH_HOME/skills`、`~/.agents/skills`、`<project>/.dsh/skills`、`<project>/.agents/skills`、
`sources.extraSkillRoots`、运行时 `office-skills`、`DSH_BUNDLED_SKILL_DIR`、**插件自带的 `skills/`**。
重名会加 `~来源` 后缀。

**插件**：当前 profile 的 `dependencies` ∪ `dsh.profile.bundles`，到 `profiles/<name>/node_modules/<包名>` 解析。
`@deepseek-ai/*` 基础包默认跳过（`sources.includeBuiltinPlugins: true` 可开）。

排除：名字**全等**于 `zip.exclude` 任一项的直接不进包（大小写不敏感；`.git` 不会连 `.github` 一起吃掉）；
单文件超 `maxFileMB` 跳过并写进 `warnings`；条目数封顶 **65000**（zip 的 16 位字段上限是 65535，超了会明确报错）。

---

## 7. 自检

```powershell
cd <插件目录>
node --check lib\index.js; node --check client.js
node test\selfcheck.mjs      # 41 项：zip / 遍历 / 配置回写 / 设置项 / 调度 / 真跑 / 增量 / 历史（含防误删）/ 导入 / 路径穿越 / 无损 JSON / apply()
node test\webdav-e2e.mjs     # 假 WebDAV：MKCOL / PUT / 认证 / sha256 / manifest + 自检结论文案（含 401）
node test\host-lossless.mjs  # 借宿主自己的校验器验工具输出
node test\mock-dav.mjs 8791  # 起一个假 DAV，供人工在设置页里点「测试 WebDAV」看绿色横幅
```

### WebDAV 失败的翻译表（面板里直接显示）

| 现象 | 面板会说 | 让你做什么 |
|---|---|---|
| 未启用 / 缺地址 / 缺密码 | 具体缺哪一项（`DISABLED` / `NO_URL` / `NO_PASSWORD`） | 坚果云与 Nextcloud 的地址示例都给了 |
| 401 / 403 | 认证被拒 | 坚果云要用「应用密码」，不是登录密码 |
| 404 | 路径不存在 | 检查 `dav/` 结尾、Nextcloud 的 `remote.php/dav/files/用户名/` |
| 405 | 服务端不接受该操作 | 这个地址可能不是标准 WebDAV 端点 |
| 5xx / 507 | 服务端出错 / 空间不足 | 稍后再试 / 清云端空间 |
| ENOTFOUND | 域名解析失败 | 域名写错或没有网络 |
| ECONNREFUSED | 连接被拒绝 | https 写成 http、端口不对 |
| UND_ERR_SOCKET（other side closed） | 连接被对端中断 | 已自动重试一次；反复出现是代理/限流 |
| 超时 | 请求超时 | 把「单请求超时」调到 120000 |

### client.js 改动的五步纪律（血泪教训，别跳）

1. 复制到 `<插件目录的隔壁>/_archivertest`，改动只做在副本上
2. 在 `~/.dsh/profiles/pixtest` 里 junction 到副本，bundles 加 `dsh-archiver`
3. `dsh --profile pixtest --port 0 --no-open` 起真宿主，**打开真实页面**：
   - console 出现 `entry did not activate` / `dsh-archiver: failed` → 失败
   - 设置里能看到「归档备份」且面板能读能存 → 通过
4. 通过后才同步回正式目录（逐文件比 hash）
5. 让用户重启 / 刷新页面确认

> `inject` 只写真正用到的服务（本插件：`['slots']`）。少写一个 → apply 里一访问就抛
> `cannot get property "x" without inject` → 页面加载即崩。

---

## 8. 卸载

```powershell
# 1) profile/package.json：bundles 与 dependencies 去掉 dsh-archiver
# 2) 删 junction（只能用 .Delete()，别对 junction 用 Remove-Item -Recurse）
(Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-archiver").Delete()
# 3) 数据：$env:USERPROFILE\.dsh\dsh-archiver\（config / state / log / out）
```

---

## 9. 设计取舍

- **设置页只注册一个槽位**（`settings.section`），不碰左栏 / 会话区；`inject: ['slots']` 一个不多。
- **字段表在服务端**（`lib/schema.mjs`）：前端不写死字段，加设置项不必重验页面。
- **自己写 zip**：fflate 在 profile 树里有时有有时没有，裸 import 会变成"运气依赖"。
- **`node_modules` 默认不进包**：收的是源码与资源，依赖可重装。
- **增量靠 stat**：文件数 + 总字节 + 最新 mtime，不读内容；只在「flat + 本地」时复用，避免远端状态对不上。
- **不裸 import 官方包**：`@deepseek-ai/dsh-tools` 是按绝对路径从宿主那棵树里取的，所以 package.json
  里不声明 `peerDependencies` —— 省掉一类「peer 范围匹配不到预发布版 → ERESOLVE」的坑。

---

## 10. 许可与反馈

MIT，见 [LICENSE](LICENSE)。问题与建议走 [Issues](https://github.com/chiya695/dsh-archiver/issues)；
想改代码直接 PR，改动后请跑一遍 `node test\selfcheck.mjs`（41 项）与真宿主验证。


