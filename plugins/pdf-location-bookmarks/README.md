# PDF 位置书签

把 PDF 的页码、选区和章节存进 Obsidian 原生书签。入口位于书签面板上方和 PDF 页头；重复收藏同一位置会更新标题。

## 安装与使用

1. 将发布包里的 `pdf-location-bookmarks` 文件夹放到库的 `.obsidian/plugins/`，确保其中有 `main.js`、`manifest.json`、`styles.css`。
2. 在 Obsidian 设置中启用核心插件 **书签**，再启用社区插件 **PDF 位置书签**。
3. 打开一份 PDF，运行命令 **收藏当前 PDF 位置** 或 **从当前 PDF 目录挑选位置**。确认窗口会显示真实的位置类型，确认保存后才写入书签。

无需账号或 API Key。此插件可以独立安装，无需回顾工作台。

| 能力 | 依赖 |
| --- | --- |
| 当前页、可用的阅读偏移、PDF 内部目录 | Obsidian 桌面版与核心书签 |
| 文字选区、当前批注 | 可选 [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) |

没有 PDF++ 或没有检测到选区时，明确退回当前页。目录中的外部链接不会进入收藏列表。

## 数据与兼容性

书签仍由 Obsidian 保存在本库 `.obsidian/bookmarks.json`，按「PDF 位置 → 书名」分组。不同路径的同名 PDF 分开保存。插件不修改 PDF、不上传内容；停用后，已保存的原生书签仍可使用。

保存会等待原生持久化结束，失败时不报成功，并尽量回退本次内存修改。磁盘回退也失败时会明确提示；原生接口不是数据库事务，遇到存储故障应重新打开书签核对。

初版仅启用桌面端。核心书签、PDF.js 和 PDF++ 的相关接口可能随版本变化，纯逻辑与模拟界面测试不能替代真实应用验收；升级后请核对选区与页码跳转、重复收藏和取消保存。

## 开发

使用 Node 20+，没有运行时第三方 JS 依赖。编辑 `main.src.js` / `core.js` 后重新构建：

```sh
node build.js
node --check main.js
node --test test/*.test.js
```

测试使用独立内存数据，不读取个人库或实际书签。代码采用 [MIT 许可](https://github.com/crown-sports/zhixing-notes/blob/main/LICENSE)。
