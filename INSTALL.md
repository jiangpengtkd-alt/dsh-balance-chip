# 安装与平台支持

> 安装入口不止本文件 —— 同目录还有 [QUICKSTART.md](./QUICKSTART.md)（中文上手，含每个数字的定义）。
> 技术细节（数据来源、计价规则、实现要点）见 [README.md](./README.md)，
> 版本历史见 [CHANGELOG.md](./CHANGELOG.md)。

## 一、运行环境

| 项 | 要求 | 原因 |
|---|---|---|
| **DSH 桌面版** | 已安装并能正常启动 | 插件运行在它里面 |
| **Node** | **≥ 22.15.0** | host 端用 `node:zlib` 的 `zstdDecompressSync` 解压会话日志（0.10.3 修正：原先误写 `>=20`，CI 在 Node 20 上直接 import 失败） |

> DSH 桌面版**内置** Node（实测 24.18.1），满足要求 —— 正常安装 DSH 的用户不必另外装 Node。
> 这个要求只在"用外部 Node 跑 `tools/` 下的测试脚本"时才需要自己满足。

## 二、平台支持

**插件是纯 JavaScript，Windows / macOS / Linux 同一份代码都能跑。**

> 早先的版本这里写过"macOS ❌ 官方无 macOS 构建" —— **那是错的**，放在引用块里
> 是因为它是被纠正的错误结论。依据只是本机安装目录里的构建元数据，
> 那描述的是**这一台机器**，不是官方发布的平台列表。
> macOS 版确实存在，且已实测跑通。

| 平台 | 状态 | 已验证的组合 |
|---|---|---|
| **Windows x64** | ✅ 实机验证 | win32-x64 + DSH 0.2.0-rc.2（Node 24.18.1） |
| **macOS arm64** | ✅ 实机验证 | darwin-arm64 + DSH 0.2.0-rc.2（Node 24.18.1） |
| macOS x64 | 预期可用 | 同一份代码，未单独验证 |
| Linux | 预期可用 | 同一份代码，未单独验证 |

判断你自己的 DSH 是哪个平台，读安装目录里的 `resources/app.asar` → `dsh/desktop-runtime.json`：

```json
{ "platform": "darwin", "arch": "arm64", "release": { "version": "0.2.0-rc.2", "nodeVersion": "24.18.1" } }
```

`platform` 在 Windows 上是 `win32`、macOS 上是 `darwin`、Linux 上是 `linux`。

> ⚠️ 这里曾经引用过一个更新源地址并声称"实测 200 / 其余 404"。那些说法**不成立** ——
> 那是我猜的 URL，实测全部 404。**而"只有 win-x64 一个 feed"的结论也因此是错的**：
> `feeds/win-x64/` 是**本机安装实例**的更新地址，Mac 安装实例用的是 `feeds/darwin-*`。
> 现已改为引用构建元数据 + 实机验证结果。

### 插件本身是跨平台的

因为它：

- 纯 JavaScript，**无原生模块**（没有 `.node` 二进制）
- **无 install / postinstall 脚本**，无编译步骤
- 无 `process.platform` / `win32` / 盘符 / 反斜杠 之类的平台判断
- 唯一涉及文件路径的地方走 `path.join(os.homedir(), ".dsh")`，
  在 macOS 上是 `/Users/<你>/.dsh`，在 Linux 上是 `/home/<你>/.dsh`
- `cordis.patch.yml` 用 POSIX 相对路径 `./cordis.patch.yml`
- client 半身运行在浏览器里，与操作系统无关
- 节假日表是内置静态数据，运行时**不访问任何外部接口**

---

## 二、安装（按方便程度排序）

### 方式 1：从 tarball 安装 —— 推荐，离线可用

把 `.tgz` 拷到目标电脑（U 盘、网盘、`scp`、AirDrop 都行），在**目标电脑**上执行：

**Windows（PowerShell）**

```powershell
dsh plugin --profile desktop add "C:\路径\dsh-balance-mini-<版本>.tgz"
```

**macOS / Linux（bash / zsh）**

```bash
dsh plugin --profile desktop add ~/Downloads/dsh-balance-mini-<版本>.tgz
```

> 这条命令已在 macOS（darwin-arm64）上实测通过。
> 原先这里带着一句"等官方发布宿主"的旧限定语 —— 那是平台表改对之前留下的，
> 与同一份文档第 26–31 行的表格直接矛盾。
> （2026-10 复核时发现：它是 0.10.4 那次修复的同类残留，只是换了措辞，
> 所以躲过了当时的关键词式断言。断言判据已改为语义式，见 CHANGELOG 0.10.6。）

> 提示：路径含空格时必须加引号；`~` 在引号内不会展开，若路径含 `~` 请写完整路径
> 或用 `"$HOME/Downloads/..."`。

装完**重启 DSH**。不需要联网。

### ⚠️ 从仓库的 `releases/` 直接安装会踩的坑

如果你是按 `dsh plugin add ./releases/dsh-balance-mini-<版本>.tgz` 装的，
profile 里记的是**那个路径**。而 `releases/` 里**只保留当前版本**（打包脚本会清掉旧产物），
所以下次 `git pull` 把旧 tgz 删掉之后，pnpm 在解析现有依赖时会直接 ENOENT：

```
[ENOENT] no such file or directory, open '…/releases/dsh-balance-mini-0.10.5.tgz'
dsh: plugin command failed    [exit=254]
```

**结果：新版本也装不进去**，因为它在解析旧依赖时就挂了。

**正确做法**：装之前先把 tgz 拷到**不随 `git pull` 变动**的位置：

```bash
cp releases/dsh-balance-mini-<版本>.tgz ~/.dsh/plugins/
dsh plugin --profile desktop add ~/.dsh/plugins/dsh-balance-mini-<版本>.tgz
```

**已经踩了的话，两步恢复**：

```bash
dsh plugin --profile desktop remove dsh-balance-mini   # 摘掉悬空依赖
dsh plugin --profile desktop add <新 tgz 的稳定路径>   # 再装
```

> 顺带记一笔行为：`remove` 会**同时**从 profile 的 `dsh.profile.bundles` 里移除条目，
> `add` 会加回去 —— 这两步是对称的，不用手工改配置文件。

### 方式 2：拷目录 + 一条命令 —— 想改代码时用

`add` 接受本地目录，DSH 会在 profile 里建一个指向它的链接，
**以后改代码重启即生效**，不必重新安装。

**Windows**

```powershell
# 把整个插件目录拷到目标电脑，例如 D:\plugins\dsh-balance-mini
dsh plugin --profile desktop add "D:\plugins\dsh-balance-mini"
```

**macOS / Linux**

```bash
# 例如 ~/dsh-plugins/dsh-balance-mini
dsh plugin --profile desktop add ~/dsh-plugins/dsh-balance-mini
```

### 方式 3：发布到 npm —— 之后一行命令装，且可更新

包名 `dsh-balance-mini` 目前在 npm 上**未被占用**。若你有 npm 账号：

```bash
# 在插件目录里执行
npm login
npm publish          # package.json 里 publishConfig.access 已是 public
```

之后任何一台电脑上（需联网）：

```bash
dsh plugin --profile desktop add dsh-balance-mini
```

---

## 三、关于 `--profile`

`desktop` 是 profile 名，**不是固定值**。真实名字是 `~/.dsh/profiles/` 下的目录名：

```bash
ls ~/.dsh/profiles          # macOS / Linux
dir %USERPROFILE%\.dsh\profiles   # Windows
```

如果你用别的名字，把命令里的 `desktop` 换掉即可。装错 profile 不会报错，
但重启后看不到效果。

---

## 四、装完怎么确认

重启 DSH 后，**输入框下方那一排**（上下文圆圈右边）应出现一个带颜色圆点的胶囊：

```
◉ ¥569.37 · ¥0.016 · ¥7.62
   ↑余额     ↑本次    ↑会话累计
```

检查清单：

1. **位置** —— 在上下文圆圈右边，与另外几个统计胶囊同一排
2. **字号** —— 应与左边「上下文百分比」及另外几个胶囊**完全一致**
3. **三段标签** —— 显示为 `余额 ¥… · 本次会话 ¥… · 本轮对话消耗 ¥…`。
   三个数含义不同：余额是账户快照；**本次会话**是本会话建立至今的累计；
   **本轮对话消耗**是你这一句话从发出到此刻的合计。
   **三段始终占位**：本轮还算不出来时显示 `—`（不会整段消失）
4. **圆点颜色** —— 余额 ≥100 绿 · 20–99 黄 · 1–19 红 · 其他灰
5. **点击** —— 弹出明细浮层（余额 / 本次会话 / 每轮平均消耗 / 本轮对话消耗 /
   会话 token 与缓存占比 / 本轮 token / 单价 / 时段 / 数据来源）
6. **关闭** —— 点击浮层外部或按 Esc

---

## 五、没出现怎么办

### 1）有「第三方插件加载失败」的恢复提示

点它恢复。**注意：该动作会备份并重置你 profile 的 `cordis.patch.yml`**
（你的自定义设置会丢，插件清单也会被改回模板）。恢复后把备份还原回去：

```bash
ls ~/.dsh/profiles/<profile>/cordis.patch.yml.bak-*
# 把你需要的那份拷回 cordis.patch.yml，然后重启 DSH
```

### 2）没有恢复提示，但插件不显示

按顺序排查：

| 检查 | 方法 |
|---|---|
| DSH 版本是否匹配 | 本插件按 `0.2.0-rc.2` 开发并验证；宿主 API 若变动可能需适配，重点看 README 的「实现要点」 |
| profile 名是否正确 | 见上面第三节 |
| 账号是否已登录 | 余额走 `deepseekAccount` 服务，未登录时胶囊会显示"余额未配置"或"余额不可用" |
| 是否装到了别的 profile | `dsh plugin --profile <名字> list` |

### 3）余额显示但消费不显示

消费需要**当前会话有 token 用量**。新会话刚建立的头几秒 host 侧可能还取不到，
客户端会以 3 秒间隔快速重试，通常几秒内自动补上（这是设计，不是故障）。

---

## 六、卸载

```bash
dsh plugin --profile desktop remove dsh-balance-mini
```

然后重启 DSH。若是方式 2 装的，再删掉你拷过去那个目录。
