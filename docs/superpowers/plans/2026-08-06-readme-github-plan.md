# GitHub README 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 README 重构为中文为主、信息真实、适合 GitHub 首页阅读的项目文档。

**Architecture:** 仅更新根目录 `README.md`，按项目定位、特性、安装、启动、模型配置、开发、数据与许可证组织。删除不存在的脚本和死链接，所有命令与当前配置一致。

**Tech Stack:** Markdown, React/Vite, FastAPI, SQLite, Electron.

---

### Task 1: Rewrite the GitHub landing-page README

**Files:**
- Modify: `README.md`

- [x] 根据当前代码与脚本写入真实的项目简介、功能、快速开始、LLM 配置、开发命令、数据与许可证。
- [x] 移除不存在的 `check_env.cmd`、`build-exe.cmd` 和失效文档链接。
- [x] 保留前端 `15173`、后端 `28000`、`npm test`、`npm run build` 等可执行命令。

### Task 2: Validate documentation accuracy

**Files:**
- Test: `README.md`

- [x] 搜索旧运行命令和失效链接。
- [x] 核对快速开始中的端口、目录和脚本名称。
