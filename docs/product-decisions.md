# 从示例库到日常工作台

## 0.2.0：让每条记录有去处

0.1.1 解决了“怎么下载、怎么记第一条”。继续使用时仍有两个断点：收集箱只能看、整理要来回切换目录；每周回顾只有空模板，没有带来要回顾的材料。

本轮复用已有插件，加入一个日常入口：**快速记录 → 看一条原文 → 移到笔记、项目或归档 → 生成本周回顾**。保留原有卡片功能，插件 ID 仍为 `review-workbench`，显示名称改为“知行工作台”。

## 研究与取舍

2026-10-22 查询 GitHub 与官方文档。Star 是当时的参考值，不能代表功能适合所有用户。

| 参考 | Star | 观察 | 本次取舍 |
| --- | ---: | --- | --- |
| [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) | 4,067 | 汇总结果关联原笔记 | 以真实文件为准，移动成功才更新列表 |
| [QuickAdd](https://github.com/chhoumann/quickadd) | 2,383 | [收集箱示例](https://quickadd.obsidian.guide/docs/Examples/Template_AddAnInboxItem/)使用时间戳；[批量移动示例](https://quickadd.obsidian.guide/docs/Examples/Macro_MoveNotesWithATagToAFolder/)没有预览和撤销 | 给出正文预览，逐条移动，支持撤销最近一次移动 |
| [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) | 1,362 | 周期性创建或打开；[#128](https://github.com/liamcain/obsidian-periodic-notes/issues/128)的 ISO 周编号问题仍开放 | 用本地周一起始日期命名；再次打开不覆盖已有内容 |
| [Homepage](https://github.com/mirnovov/obsidian-homepage) | 730 | 稳定入口；[#142](https://github.com/mirnovov/obsidian-homepage/issues/142)报告重复标签页 | 按工作台类型和真实 TFile 复用已打开页面 |

QuickAdd [#337](https://github.com/chhoumann/quickadd/issues/337)已有实现和发布记录；[#2244](https://github.com/chhoumann/quickadd/issues/2244)的后续修复当时尚未进入最新发行版。学习这些问题时区分已发布、待发布和未解决，不把旧问题当成现有缺陷宣传。

## 文件操作的约定

- 空白或取消不写文件；同名记录不覆盖。
- 目录由用户设置，保存设置不移动原有笔记，不替换库配置。
- 移动和撤销使用 Obsidian FileManager；链接是否更新遵循原库偏好。原位置已占用时拒绝撤销。
- 周回顾是生成当时的链接快照，标明时间。文件修改时间不等于完成量，导入和同步也会影响它。
- 同周已有笔记只打开，用户补写的内容不被重新生成覆盖。
- 主流程没有云服务或模型请求。停用插件后文件继续可读。

## 下一轮验证的问题

卡片自测目前不持久化“想起来了/还不熟”结果，练习输入也不保存。后续应先验证是否需要普通 Markdown 练习日志，再决定展示方式；不把它冒充为 Spaced Repetition 的排期记录。本轮先把日常整理流程做完整。
