# 参与与发版

给想改代码或发版的人看。只想用插件的，看 [README.md](../README.md) 就够了。

## 提 PR

- 从 `main` 开分支。`main` 有保护：必须走 PR，且 `test (22)` / `test (24)` 要过
- **`package.json` 不许出现 `scripts` 字段。** 安装包里的 `package.json` 不受 `files`
  白名单控制，一旦有 `install` / `postinstall`，装插件的人机器上就会执行它。
  `tools/pack-release.mjs --check` 有一条断言专门盯这个
- `files` 里别写目录通配（`"lib/"` 这种）。那会把工作区里没提交的文件一起打进安装包。
  已有断言："tgz 里每个条目都必须是 git 跟踪的文件"
- 改文档也影响发布：`README` / `INSTALL` / `QUICKSTART` / `CHANGELOG` 都在安装包里，
  改了就要重新打包发版

## 发版

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 顶部加一节 `## <版本>`
   （Release 说明就是从这里摘的）
2. 提交并推送 `main`
3. 打 tag 并推送：

   ```bash
   git tag -a v0.15.0 -m "一句话说明"
   git push origin v0.15.0
   ```

4. `.github/workflows/release.yml` 会自动：跑全套测试 → 从该 tag 打包 →
   生成 `SHA256SUMS.txt` → 建一个 **draft** Release
5. 去 Releases 页面检查，没问题点 **Publish release**

**tag 与 `package.json` 版本必须一致**，否则 workflow 在第一步就失败。
版本标签受保护，不能移动或删除。

## 为什么这么设计

- 产物由 CI 从 tag 的代码构建，用户能在 Actions 里查到"这个包对应哪份代码"
- 只发 `.tgz`，不发 zip：`dsh plugin add xxx.zip` 会直接报错，下载页放两个文件必然有人点错
- 细节（踩过的坑、为什么这么判）见 `CHANGELOG.md` 与 `README.md` 的「实现要点」
