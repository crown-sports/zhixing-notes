# 回顾工作台

把值得记住的内容写成问题，再合上答案回忆。卡片始终是普通 Markdown，停用插件后仍可阅读和编辑。

- **新建卡片**：直接填写标题、问题和答案，空库也能开始。
- **回忆与整理**：按主题、关键词和待完善状态筛选；快速自测隐藏答案。
- **补充理解**：更新“回顾分析”节；遇到同节冲突、手写前言或自定义字段时停止保存，提示直接编辑原文。

## 安装与使用

把发行包内的 `main.js`、`manifest.json`、`styles.css` 放进库的 `.obsidian/plugins/review-workbench/`，重启 Obsidian 并在第三方插件中启用。

在命令面板运行“回顾工作台：打开回顾工作台”或“新建回顾卡”。默认扫描 `20_笔记/回顾卡片/`，可在插件设置中选择其他库内目录；修改设置不会移动原笔记。初版仅启用桌面端。

已有卡片可使用以下格式，分类支持任意主题：

```markdown
---
category: 读书
---
# 主动回忆

#flashcards/review

为什么先回忆再看答案？
?
先独立提取知识，再检查遗漏。
```

快速自测不计分、不调整复习日期。需要间隔排期时，可自行安装 [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) 并启用 `#flashcards` 标签，再使用“间隔复习这张卡”。本插件检查问答是否完整，**不判断知识是否正确**。

新建表单一次收录一张卡。问题和答案内不要放独立标题、`---` 分隔线、复习标签或详解块；表单会阻止这些可能截断自测内容的写法。来源和扩展材料可在创建后写到卡片外。

## 开发

使用 Node.js 20 或更新版本，无第三方构建依赖：

```sh
node --test data.test.js main.test.js
node build.js
node --check main.js
```

测试使用合成内容和内存库，不读取用户笔记。源文件为 `main.src.js`、`data.js`、`styles.css`；`main.js` 由构建生成。许可沿用项目根目录 MIT LICENSE。
