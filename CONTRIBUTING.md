# 贡献指南

感谢你愿意参与「小说剧本智能分析工作台」（仓库名 `ai-novel-screenplay-analyzer`）的建设。本项目以中文为主要文档语言，技术标识保留 `storymap`。

## 如何开始

1. Fork 本仓库并 clone 到本地。
2. 在根目录安装依赖：

   ```bash
   pip install -r requirements.txt
   npm install
   ```

3. 启动本地开发环境：

   ```bash
   start.cmd
   ```

   或分别启动后端（`python backend/main.py`，端口 `28000`）与前端（`cd frontend && npm run dev`，端口 `15173`）。

4. 创建功能分支：

   ```bash
   git checkout -b feat/your-feature
   ```

## 提交规范

- Commit message 使用 `feat:`、`fix:`、`docs:`、`chore:`、`style:`、`refactor:`、`test:` 前缀。
- 正文说明改动动机与影响，尽量不超过 72 字符的标题行。
- 不要提交数据库文件（`storymap.db`）、日志、构建产物、截图或本地密钥。

## 代码与测试要求

- 后端：改动后运行 `python -m unittest discover -s backend -t .`，保持全绿。
- 前端：改动后运行 `npm test --workspace frontend` 与 `npm run build --workspace frontend`。
- 提交前至少运行一次相关测试；新增行为应有对应测试。

## Pull Request

- PR 标题使用与 commit 相同的规范前缀。
- 描述改动内容、验证方式，必要时附上截图或复现步骤。
- 等待维护者 review 后再合并。