# ai-novel-screenplay-analyzer

![License](https://img.shields.io/badge/license-MIT-green) ![Python](https://img.shields.io/badge/python-3.10-blue) ![Node](https://img.shields.io/badge/node-20.19%2B-brightgreen)

## 小说剧本智能分析工作台

小说剧本智能分析工作台：面向长篇小说、剧本与改编项目，自动梳理人物关系、章节脉络与关系演化，支持多模型接入、长任务断点恢复及本地私有部署。

它把长篇原文整理为可复核的项目底稿，帮助出版编辑、影视开发、制片和版权评估团队更快形成共同理解。

> 不是替你读小说，而是让团队读同一本小说。

## 功能特性

- **多项目管理**：按原著或剧本创建独立项目，支持重命名、切换、导入和导出。
- **关系全景**：基于 AntV G6 展示人物、势力与关系，支持章节范围、出现次数阈值和关系轨迹筛选。
- **章节脉络**：自动识别章节并按上下文切分长文本，保留章节信息和切片进度。
- **关系演化**：追踪同一对人物在不同章节中的关系变化。
- **人物档案**：查看人物的关系数、出现章节、关键事件和可追溯关系信息。
- **关系行数**：关系描述支持 1/2/3/5 行切换，长文本说明不被截断。
- **多模型接入**：支持 OpenAI-compatible、火山方舟和阿里百炼协议。
- **可靠长任务**：支持暂停、继续、失败切片重试、限流降并发和刷新后恢复。
- **本地优先**：分析数据存储在本机 SQLite，可用于单机或私有部署。
- **Windows 桌面版**：提供 Electron 封装和便携版打包配置。

## 目录

- [快速开始](#快速开始)
- [配置模型](#配置模型)
- [使用说明](#使用说明)
- [开发命令](#开发命令)
- [数据与安全](#数据与安全)
- [项目结构](#项目结构)
- [API 文档](#api-文档)
- [贡献与许可证](#贡献与许可证)

## 快速开始

### 环境要求

- Python 3.10+
- Node.js 20.19+（或 22.12+；Vite 7 的运行要求）
- npm
- Windows 一键启动可选：Conda/Miniconda 环境 `vevo`

### 安装依赖

在仓库根目录执行：

```bash
# Python 后端依赖
pip install -r requirements.txt

# 前端与 Electron 工作区依赖
npm install
```

使用 Conda 时：

```bash
conda env create -f environment.yml
conda activate vevo
pip install -r requirements.txt
npm install
```

### 启动服务

项目由一个后端服务和一个前端开发服务器组成。

#### Windows 一键启动

```bat
start.cmd
```

Windows 启动脚本会显式将 SQLite 指向当前仓库根目录的 `storymap.db`。

#### 手动启动

终端 1：

```bash
python backend/main.py
```

终端 2：

```bash
cd frontend
npm run dev
```

启动后访问：

- Web 应用：<http://localhost:15173>
- 后端 API：<http://127.0.0.1:28000>
- Swagger 文档：<http://127.0.0.1:28000/docs>

前端 Vite 会把 `/api` 请求代理到后端 `28000` 端口。

## 配置模型

打开应用左侧的模型管理面板，填写模型名称、协议、Model ID、Base URL 和 API Key，然后先测试连接再保存。

支持的协议：

| 协议 | 标识符 | 默认 Base URL | Model ID 示例 |
| --- | --- | --- | --- |
| OpenAI-compatible | `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 火山方舟 | `volcano` | `https://ark.cn-beijing.volces.com/api/v3` | `ep-xxxxx` |
| 阿里百炼 | `bailian` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |

MiniMax M3 等兼容 OpenAI 接口的模型，可选择 `openai` 协议并填写对应的 Base URL 与 Model ID。

> API Key 只在本地配置。不要把真实密钥写入 README、源码或提交到版本控制。

## 使用说明

### 快速上手

1. 创建一个小说、剧本或 IP 项目。
2. 导入原文或粘贴文本，确认章节识别和切片范围。
3. 选择已配置的模型，提交分析任务。
4. 在关系全景中查看人物、势力、关系和章节分布。
5. 打开人物档案与关系演化，复核关键关系变化。
6. 按章节范围或出现次数筛选重点，并导出项目数据作为备份或报告素材。

### 基础功能

#### 新建项目

为每部原著或剧本创建独立项目，支持重命名、切换、导入和导出，项目数据保存在本地数据库。

![基础功能：新建项目](demo/%E5%9F%BA%E7%A1%80%E5%8A%9F%E8%83%BD%20%E6%96%B0%E5%BB%BA%E9%A1%B9%E7%9B%AE.png)

#### 开始分析

导入原文或粘贴文本后选择已配置的模型提交分析；后端自动识别章节、按上下文切片，支持暂停、继续、失败重试与刷新后恢复。

![基础功能：开始分析](demo/%E5%9F%BA%E7%A1%80%E5%8A%9F%E8%83%BD%20%E5%BC%80%E5%A7%8B%E5%88%86%E6%9E%90.png)

### 高级功能

#### 人物档案

点击图谱中的人物查看档案：关系数、出现章节、关键事件和可追溯关系信息。

![高级功能：人物档案](demo/%E9%AB%98%E7%BA%A7%E5%8A%9F%E8%83%BD%20%E4%BA%BA%E7%89%A9%E6%A1%A3%E6%A1%88.png)

#### 次数和范围

按人物出现次数与章节范围筛选图谱，快速聚焦核心人物与关键关系：

- 视图模式：全部出现 / 多次出现 / 仅出现一次；「多次出现」可设置「最少出现 N 次」（2–10 次）。
- 章节范围：只看指定章节区间（如第 1–5 章）内的人物与关系。
- 图谱范围：可切换「预览」与「全部」，长篇小说默认用精简预览控制渲染开销。

好处：过滤只露一面的路人角色，突出主要人物；范围收窄后图谱更精简、渲染更快，长篇分析不卡顿。

![高级功能：次数和范围](demo/%E9%AB%98%E7%BA%A7%E5%8A%9F%E8%83%BD%20%E6%AC%A1%E6%95%B0%E5%92%8C%E8%8C%83%E5%9B%B4.png)

#### 关系行数

关系连线上的说明文字可切换 1 / 2 / 3 / 5 行显示。

好处：关系描述较长（如「结盟后背叛」「名义师徒、实际对手」）时，行数多更完整，不会被截断；行数少图谱更紧凑，适合整体浏览。

### IP 关系全景

基于 AntV G6 展示人物、势力与关系全景，支持章节范围、出现次数和关系轨迹筛选。

![IP 关系全景](demo/IP%20%E5%85%B3%E7%B3%BB%E5%85%A8%E6%99%AF.png)

### 关系演化时间线

追踪同一对人物在不同章节中的关系变化，支持全部、多次与单次模式切换和章节过滤。

![关系演化时间线](demo/%E5%85%B3%E7%B3%BB%E6%BC%94%E5%8C%96%E6%97%B6%E9%97%B4%E7%BA%BF.png)

### 开发费用预估

根据项目规模估算改编开发成本，辅助立项与预算评估。

![开发费用预估](demo/%E5%BC%80%E5%8F%91%E8%B4%B9%E7%94%A8%E9%A2%84%E4%BC%B0.png)

## 开发命令

在仓库根目录：

```bash
npm run dev                       # 启动前端开发服务器
npm run build                     # 构建前端生产包
npm test                          # 运行各工作区测试
```

在 `frontend` 目录：

```bash
npm run dev
npm run build
npm test
npm run check:api-endpoints
```

在 `electron` 目录：

```bash
npm test
npm run build:portable            # 构建 Windows 便携版
```

## 数据与安全

- 默认数据库：仓库根目录 `storymap.db`。
- 可通过 `STORYMAP_DB` 指定数据库路径。
- API Key 和项目数据保存在本地数据库或本机用户数据目录，不会由 README 或前端源码提供。
- 建议定期使用项目导出功能备份数据，并在公开仓库中忽略数据库文件和密钥文件。

常用后端环境变量：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `STORYMAP_HOST` | 后端监听地址 | `127.0.0.1` |
| `STORYMAP_PORT` | 后端监听端口 | `28000` |
| `STORYMAP_DB` | SQLite 文件路径 | `storymap.db` |
| `STORYMAP_LLM_CONCURRENCY` | LLM 并发数 | `3` |
| `STORYMAP_LLM_REQUEST_TIMEOUT` | 单次分析请求超时（秒） | `120` |
| `STORYMAP_CORS_ORIGINS` | 自定义 CORS 来源列表 | 空 |

## 项目结构

```text
.
├── backend/
│   ├── main.py                 # FastAPI 后端与 SQLite 数据层
│   └── *_test.py               # 后端测试
├── frontend/
│   ├── src/                    # React 页面、状态与分析流程
│   ├── vite.config.js          # Vite 端口与 API 代理
│   └── package.json
├── electron/                   # Windows Electron 封装与数据库迁移
├── start.cmd                   # Windows 一键启动
├── start_backend.cmd           # 仅启动后端
├── start_frontend.cmd          # 仅启动前端
├── requirements.txt
└── package.json
```

## API 文档

后端启动后访问 <http://127.0.0.1:28000/docs> 查看完整 OpenAPI 文档。

主要接口包括：

- `/api/projects`：项目创建、查询、更新、删除、导入和导出
- `/api/projects/{id}/analyze`：提交文本分析任务
- `/api/llm-models`：模型配置管理与连接测试
- `/api/task-progress`：长任务进度保存、恢复和清理

## 贡献与许可证

欢迎通过 Issue 反馈问题，或提交 Pull Request 改进功能、文档和测试。提交代码前请至少运行相关工作区的测试与前端构建。

本项目采用 [MIT License](LICENSE)。

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区进行开源推广，感谢社区佬友的交流、反馈与建议。

## 作者

你们喜爱的老王 — [B 站 @你们喜爱的老王](https://space.bilibili.com/97727630)

---

小说剧本智能分析工作台：让每一次立项，都有原文依据。

