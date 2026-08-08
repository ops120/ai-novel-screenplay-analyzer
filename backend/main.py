r"""小说剧本智能分析工作台后端（单文件 FastAPI 服务）

v6 安全回归修复（紧接 v5）：
  Fix-1 (P0) 删除 resolve_api_key 兼容垫片：_call_llm 只接受已注册 llm_models.id，
          杜绝「客户端可控 base_url + 后端密钥」外发链路。
  Fix-2 (P0) CORS 移除 "null"（iframe sandbox 攻击 Origin），仅保留本地开发源。
  Fix-3 (P1) 项目 ID 升级到 secrets.token_urlsafe(16)（22 字符 base64，128-bit），
          旧 hex ID 仍可读；新建必须用新算法。
  Fix-4 id pattern 收紧到 ^[^\s,]+$，排除空白和逗号（防 GROUP_CONCAT 污染 + __proto__）。
          AnalyzeNode 主入口同样收紧。
  Fix-5 Export 默认密文（Fernet），仅 ?format=plaintext 显式标志才返明文。
  Fix-6 SQLite foreign_keys 真正生效：isolation_level=None + connection 级别 PRAGMA
          + 启动期插入非法 FK 验证。
  Fix-7 semaphore 改用 try/finally 显式 release，杜绝超时路径下的计数泄漏。
  Fix-8 413 响应补 CORS 头（中间件提前返回会绕过 CORSMiddleware 的 allow-origin 注入）。
  Fix-9 /llm-models/test 失败返正确状态码：422（未注册）/ 502（上游）/ 504（超时）。
  Fix-10 导入路径应用 _canonical_direction 规范化（A→B/B→A 只保留一条边）。

v8 契约回归修复（v7 验证发现 v6 关闭 P0 攻击链时引入 3 个用户主功能契约断裂）：
  v8-Fix-1 (P0) LLMModel.api_key 改 Optional[str]=None + PUT handler「空 api_key 保留原密钥」
          → 修 LLMManager.handleEdit：前端 LLMModelOut 剥了 api_key 字段，PUT body 中
          api_key 是 undefined；之前会被 Pydantic 422 missing 拦掉。
  v8-Fix-2 (P0) TestLLMRequest.extra 由 "forbid" 改 "ignore"，但 schema 只定义 model_id。
          → 修 LLMManager.testLlmModel：前端发 {api_key, base_url, model_id, protocol}
          多余 UI 字段不再 422；但 base_url+api_key 永远从 _lookup_llm_model(model_id)
          库中查，杜绝客户端注入回归。
  v8-Fix-3 (P1) id 黑名单：Python re 不支持 lookahead/lookbehind，spec 推荐的
          `^(?!__proto__|constructor|prototype$)[^\s,]+$` 改用 field_validator 枚举实现
          （__proto__/constructor/prototype 显式枚举 → 422）。保留原 ^[^\s,]+$ 限制。
  v8-Fix-4 (P1) limit_body_size 中间件改 await request.body() 累计，chunked 编码绕过
          Content-Length 的攻击防御。
  v8-Fix-5 (P3) /analyze 错误码统一：422(model_not_registered)/ 502(upstream_error)/
          504(timeout)/ 500(internal)，与 /test 模式同步。

v9.1 稳定性 hotfix（v9 实测：_lookup_llm_model 间歇抛 "no such table: llm_models"，
后端需重启才恢复）：
  v9.1-Fix-0 (根因) DB_FILE 在导入期解析为绝对路径。原来是相对路径，每次
          sqlite3.connect() 都相对当时的 CWD 解析；一旦库文件被移走/删除
          （v9 verify 脚本的 `mv storymap.db storymap.db.bak` 就是这么干的），
          下一次 connect() 会**静默新建一个空库**，于是所有表凭空消失。
          绝对路径不能阻止「文件被删」，但消除了 CWD 漂移这一独立故障源。
  v9.1-Fix-1 (P1) get_db() 每条新连接都设 busy_timeout=30s + journal_mode=WAL +
          foreign_keys=ON，并给 connect() 加 timeout=30.0。锁等待不再立刻
          SQLITE_BUSY。保留 v6 的 isolation_level=None（FK 生效的前提，勿删）。
  v9.1-Fix-2 (P1) init_db() 末尾启动自检：打印 journal_mode / foreign_keys 实际值，
          journal_mode 不是 wal 时重试一次并告警；FK 自检沿用 v6 Fix-6。
  v9.1-Fix-3 (P1) _db_call_with_retry()：捕获 "no such table" 型 OperationalError，
          调 init_db() 重建 schema 后重试 1 次。_lookup_llm_model 走这条路径，
          库文件被外部删除后不再需要重启进程。
  v9.1-Fix-4 (P2) 所有 DB 端点改 try/finally 关连接。原来 19 处 conn.close() 只有 3 处
          有 try/finally，任何中途异常都会泄漏连接（WAL 下还会钉住 -wal 文件）。
"""

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict, AliasChoices, ValidationError, field_validator
from openai import OpenAI
from typing import Optional, List, Any
import sqlite3, secrets, json, re, os, asyncio, base64, hashlib, socket, time

# v25-fix：大文本进度断点改用本地持久化（替换浏览器 localStorage 5MB 配额）。
# 需要写入原始文本（999 测试约 15MB，未来长卷可达 30MB+），所以 PUT /api/task-progress/{id}
# 走专用 64MB 通道，其它端点保持原 10MB 全局防护。
import progress_repository
import task_engine

app = FastAPI()

# ---------- Fix-2：CORS 精确白名单（v6 移除 "null"，避免 iframe sandbox 攻击） ----------
# Web 生产环境通过同源 /api 访问，无需 CORS；以下白名单仅供本地开发服务器。
# 不允许 file:// 或 "null" 来源，避免恢复已移除的桌面传输兼容及 sandbox 攻击面。
# 可用环境变量 STORYMAP_CORS_ORIGINS（逗号分隔）覆盖。
DEFAULT_CORS_ORIGINS = [
    "http://localhost:15173",
    "http://127.0.0.1:15173",
    "http://localhost:5189",
    "http://127.0.0.1:5189",
]
_cors_env = os.environ.get("STORYMAP_CORS_ORIGINS", "")
CORS_ORIGINS = [o.strip() for o in _cors_env.split(",") if o.strip()] or DEFAULT_CORS_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# ---------- Fix-4 + Fix-8：请求体大小上限（413 补 CORS 头） ----------
MAX_BODY_BYTES = 10 * 1024 * 1024  # 10MB
# v25-fix：大文本进度断点专用通道。999 测试文本约 15MB，留 4x 余量给长卷。
SPECIAL_LARGE_PUT_LIMIT_BYTES = 64 * 1024 * 1024  # 64MB


def _maybe_add_cors_headers(response: JSONResponse, request: Request) -> JSONResponse:
    """Fix-8：中间件直接返回的 JSONResponse 不会经过 CORSMiddleware 的 allow-origin 注入，
    导致浏览器只见 network error。手动补一次（基于白名单）即可。"""
    origin = request.headers.get("origin", "")
    if origin and origin in CORS_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Vary"] = "Origin"
    return response


def _body_size_limit_for(request: Request) -> int:
    """按 URL + method 计算请求体上限。

    专用 PUT /api/task-progress/{id} 给 64MB（写原文断点），其它端点保持 10MB。
    单独的 URL 前缀匹配避免误伤：仅该路径的 PUT 走大通道，POST/DELETE 仍走 10MB。
    """
    if (request.method == "PUT"
            and (request.url.path.startswith("/api/task-progress/")
                 or request.url.path.endswith("/text"))):
        return SPECIAL_LARGE_PUT_LIMIT_BYTES
    return MAX_BODY_BYTES


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """超过对应上限的请求体直接 413，避免大 JSON 打爆内存（Fix-8：补 CORS 头）。

    v8-Fix-4：原版只查 Content-Length 头，chunked Transfer-Encoding 没有该头，
    可绕过限制。改用 await request.body() 实际读取并测量大小——Starlette 会缓存，
    下游 handler 再次 request.body() 直接拿缓存，不会有双读开销。

    v25-fix：上限按 URL 路径动态决定（专用 PUT 给 64MB）。其余端点保持 10MB。
    """
    body = await request.body()
    limit = _body_size_limit_for(request)
    if len(body) > limit:
        return _maybe_add_cors_headers(JSONResponse(
            status_code=413,
            content={"status": "error", "error": "payload_too_large",
                     "message": f"请求体超过 {limit // 1024 // 1024}MB 上限"},
        ), request)
    return await call_next(request)


# v9.1-Fix-0：导入期就固化成绝对路径。
# 原来是相对路径，sqlite3.connect() 每次都相对「当时的 CWD」解析——CWD 一变（或库文件
# 被移走），connect() 不报错，而是**静默新建一个空库**，随后所有查询都是
# "no such table: xxx"。绝对路径把「连的是哪个文件」这件事在启动时钉死。
#
# 复核回归（v15-Fix-7）：默认 fallback 必须是绝对路径，不能依赖调用方的 CWD。
# 之前 `os.path.abspath("storymap.db")` 把 fallback 转成「相对 _当前进程 CWD_ 的绝对
# 路径」——CWD 一变（`cd backend && python main.py`）库文件就漂到别处，会新建空库。
# 改为以 main.py 所在目录为锚点：无论从哪个目录启动后端，库文件位置永远固定。
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
_DEFAULT_DB = os.path.join(PROJECT_ROOT, "storymap.db")
DB_FILE = os.path.abspath(os.environ.get("STORYMAP_DB", _DEFAULT_DB))

# v9.1-Fix-1：锁等待上限（秒）。SQLite 默认拿不到锁立刻 SQLITE_BUSY；
# 多进程/多连接（WAL 下 checkpoint 与写事务并发）时这会变成随机 500。
DB_TIMEOUT = float(os.environ.get("STORYMAP_DB_TIMEOUT", "30"))

# ---------- Fix-7：LLM 调用并发/超时控制 ----------
LLM_CONCURRENCY = int(os.environ.get("STORYMAP_LLM_CONCURRENCY", "3"))
SEMAPHORE = asyncio.Semaphore(LLM_CONCURRENCY)
# 单次 HTTP 请求超时（交给 OpenAI SDK）/ 整个分析请求（含重试）的兜底超时
LLM_CLIENT_TIMEOUT = float(os.environ.get("STORYMAP_LLM_CLIENT_TIMEOUT", "60"))
LLM_REQUEST_TIMEOUT = float(os.environ.get("STORYMAP_LLM_REQUEST_TIMEOUT", "120"))


def _connect():
    """建立一条配置好的连接。不做 schema 检查——init_db() 用它，避免与 get_db() 递归。

    ⚠️ isolation_level=None 是 v6 Fix-6（FK 真正生效）的前提，不要删。
    """
    conn = sqlite3.connect(DB_FILE, isolation_level=None, timeout=DB_TIMEOUT)
    conn.row_factory = sqlite3.Row
    # 顺序有讲究：busy_timeout 必须先设，否则下面的 journal_mode 在有并发写时
    # 会立刻 SQLITE_BUSY 而不是等待。
    conn.execute(f"PRAGMA busy_timeout = {int(DB_TIMEOUT * 1000)}")
    # SQLite 的 foreign_keys 是 per-connection 设置，必须每次新连接都显式打开。
    conn.execute("PRAGMA foreign_keys = ON")
    # journal_mode 是持久化设置（写在库 header 里），正常情况下这里是一次确认性读写。
    # 但若库文件刚被重建过，这一句能把它拉回 WAL。拿不到锁时不应让整条连接失败。
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError as e:
        print(f"⚠️ v9.1-Fix-1：连接期设置 journal_mode=WAL 失败（忽略）: {e}", flush=True)
    return conn


def get_db():
    """Fix-6：connection-level PRAGMA + isolation_level=None。
    v9.1-Fix-1：叠加 busy_timeout / journal_mode / connect timeout。
    v9.1-Fix-3：连接前确认库文件还在。

    库文件不存在时 sqlite3.connect() **不报错**，而是静默新建一个空库——这正是 v9
    实测 "no such table: llm_models" 的成因（库文件被备份/清理脚本移走后，进程里
    每条后续连接都指向一个空库，必须重启才恢复）。这里先补建 schema 再连，
    一次 os.path.exists() 就让**所有**端点都免疫，不用逐个包重试。
    """
    if not os.path.exists(DB_FILE):
        print(f"⚠️ v9.1-Fix-3：库文件 {DB_FILE} 不存在（被外部删除？）→ 重建 schema", flush=True)
        init_db()
    return _connect()


def _db_call_with_retry(fn, *, what: str):
    """v9.1-Fix-3：执行 fn(conn)，遇到「表不存在」型 OperationalError 时重建 schema 重试 1 次。

    get_db() 的 exists() 检查已挡掉绝大多数情况；这一层兜住两个它挡不住的残余场景：
      1) exists() 与 connect() 之间的竞态（检查通过后文件才被删）；
      2) 文件在、但表被 DROP 掉了。

    只对 "no such table" 重试——其它 OperationalError（磁盘满、库损坏、锁超时）
    重建 schema 帮不上忙，直接上抛。
    只用于**只读**查询：重试是幂等的。写路径不套这层，避免重放已部分生效的事务。
    """
    for attempt in range(2):
        conn = get_db()
        try:
            return fn(conn)
        except sqlite3.OperationalError as e:
            if "no such table" not in str(e).lower() or attempt > 0:
                raise
            print(f"⚠️ v9.1-Fix-3：{what} 遇到 {e!r} → 重建 schema 后重试", flush=True)
        finally:
            conn.close()
        # 走到这里说明是可重试的 "no such table"；重建表后进入下一轮。
        init_db()
    raise AssertionError("unreachable")  # pragma: no cover


def init_db():
    # v9.1-Fix-3：必须用 _connect() 而不是 get_db()——get_db() 在库文件缺失时会调
    # init_db()，走 get_db() 会无限递归。
    conn = _connect()
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS projects ("
            "id TEXT PRIMARY KEY, "
            "name TEXT, "
            "description TEXT NOT NULL DEFAULT ''"
            ")"
        )
        # Fix-6：补全 FOREIGN KEY 约束——v5 验证发现原 schema 没有声明 FK，
        # 即便 PRAGMA foreign_keys=ON 也不会有任何效果。
        conn.execute('''CREATE TABLE IF NOT EXISTS nodes (
            id TEXT,
            label TEXT,
            sect TEXT,
            chapter TEXT DEFAULT '',
            project_id TEXT NOT NULL,
            PRIMARY KEY(id, project_id),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )''')
        conn.execute('''CREATE TABLE IF NOT EXISTS edges (
            id TEXT PRIMARY KEY,
            source TEXT,
            target TEXT,
            label TEXT,
            chapter TEXT DEFAULT '',
            occurrence INTEGER NOT NULL DEFAULT 1,
            project_id TEXT NOT NULL,
            stage TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )''')
        # v15：旧库兼容迁移——已存在的表可能没有 chapter / occurrence 列。
        # ADD COLUMN 失败说明列已存在，忽略即可。
        for ddl, label in [
            ("ALTER TABLE nodes ADD COLUMN chapter TEXT DEFAULT ''", 'nodes.chapter'),
            ("ALTER TABLE edges ADD COLUMN chapter TEXT DEFAULT ''", 'edges.chapter'),
            ("ALTER TABLE edges ADD COLUMN occurrence INTEGER NOT NULL DEFAULT 1", 'edges.occurrence'),
            # v26：旧库（v25 之前）没有 description 列；给已存在的 projects 表加列。
            ("ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT ''", 'projects.description'),
        ]:
            try:
                conn.execute(ddl)
                print(f"✅ v15 迁移：新增 {label}", flush=True)
            except sqlite3.OperationalError as e:
                if 'duplicate column' in str(e).lower():
                    continue
                raise
        conn.execute('''CREATE TABLE IF NOT EXISTS llm_models (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            protocol TEXT NOT NULL,
            api_key TEXT NOT NULL,
            base_url TEXT NOT NULL,
            model_id TEXT NOT NULL,
            is_default INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''')

        # v25-fix：炼化断点持久化（替换 v20-v24 的 localStorage 5MB 配额方案）。
        # schema 由 progress_repository 维护，避免散落在多处。
        progress_repository.init_progress_schema(conn)

        # v26.1：项目原文表——导入的大文本只上传一次，前端不持有全文。
        # FK ON DELETE CASCADE 跟随 projects，删项目时同步清掉原文。
        conn.execute('''CREATE TABLE IF NOT EXISTS project_text (
            project_id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            encoding TEXT NOT NULL DEFAULT 'utf-8',
            chars INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )''')

        # v26.3：失败切片记录表——替换前端 localStorage 持久化。
        # 每项目一行；chunks 存 JSON 数组 [{chunkIndex, message, status?}]。
        # 删除项目时通过 FK CASCADE 联动清掉。
        conn.execute('''CREATE TABLE IF NOT EXISTS project_failures (
            project_id TEXT PRIMARY KEY,
            chunk_size INTEGER NOT NULL DEFAULT 0,
            total_chunks INTEGER NOT NULL DEFAULT 0,
            chunks TEXT NOT NULL DEFAULT '[]',
            chapter_from TEXT NOT NULL DEFAULT '',
            chapter_to TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )''')

        # v27: backend task engine - tasks table (schema owned by task_engine).
        task_engine.init_tasks_schema(conn)

        # ---------- v9.1-Fix-2：启动自检（PRAGMA 实际值，不是「我们设过了」） ----------
        journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
        if str(journal).lower() != "wal":
            print(f"⚠️ v9.1-Fix-2：journal_mode={journal}（期望 wal），重试设置", flush=True)
            try:
                conn.execute("PRAGMA journal_mode = WAL")
            except sqlite3.OperationalError as e:
                print(f"⚠️ v9.1-Fix-2：重设 journal_mode 失败: {e}", flush=True)
            journal = conn.execute("PRAGMA journal_mode").fetchone()[0]

        fk = conn.execute("PRAGMA foreign_keys").fetchone()[0]
        busy = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        print(f"✅ v9.1 启动自检：db={DB_FILE} journal_mode={journal} "
              f"foreign_keys={fk} busy_timeout={busy}ms", flush=True)
        if str(journal).lower() != "wal":
            print("⚠️ v9.1-Fix-2：WAL 未生效——并发读写可能出现 SQLITE_BUSY", flush=True)

        # Fix-6：启动期插入非法 FK 验证——必须抛 IntegrityError（FK constraint failed）。
        try:
            conn.execute(
                "INSERT INTO edges (id, source, target, label, project_id) VALUES (?,?,?,?,?)",
                ("__fk_self_test__", "a", "b", "self-test", "non-existent-project-for-fk-check"),
            )
            conn.execute("DELETE FROM edges WHERE id=?", ("__fk_self_test__",))
            print("⚠️ Fix-6 警告：FK 约束未生效（应抛 IntegrityError）", flush=True)
        except sqlite3.IntegrityError as e:
            if "FOREIGN KEY" in str(e).upper():
                print(f"✅ Fix-6 OK：FK 已生效（自检 {e})", flush=True)
            else:
                print(f"⚠️ Fix-6 警告：抛了 IntegrityError 但不是 FK 问题: {e}", flush=True)
        except Exception as e:
            print(f"⚠️ Fix-6 自检异常: {type(e).__name__}: {e}", flush=True)
    finally:
        conn.close()


init_db()

# v27: on boot, mark queued/running/paused tasks as interrupted.
try:
    task_engine.mark_stale_tasks_interrupted()
except Exception as _e:
    print(f"warn: v27 mark_stale_tasks_interrupted failed: {_e}", flush=True)


# ==================== 通用 ID 生成 ====================
# Fix-3：项目 ID 升级到 secrets.token_urlsafe(16)——128-bit 不可枚举。
# 旧 hex ID（proj_<6hex>）仍可在 GET/PUT/DELETE 路由使用，路由不做格式限制。
def _new_project_id() -> str:
    """22 字符 base64（无 padding），128-bit 熵，不可枚举。"""
    return secrets.token_urlsafe(16)


# ==================== 数据模型 ====================

# Fix-1：v6 删除 LLMConfig，不再允许请求体携带 api_key/base_url/model。
#       所有 LLM 调用必须走已注册的 llm_models.id，由后端从库中查 base_url + api_key。
class AnalyzeRequest(BaseModel):
    """Fix-1：analyze 只接受 model_id（已注册的 llm_models.id）+ text + system_prompt。
    不再有 api_key/base_url 字段——彻底切断「客户端可控 base_url + 后端密钥」外发链路。
    v15：新增可选 chunk_index / chunk_size，从客户端透传用于把章节与切片对齐。
    v19：新增可选 chunk_chapter，前端扫描章节边界后注入的当前章节名——
    LLM 若漏填 node.chapter / edge.chapter，写入路径用它兜底，
    确保「未标注章节」徽章不会因为 LLM 偷懒而泛滥。
    """
    model_config = ConfigDict(extra="ignore")
    # 文本可空：前端只传 project_id 时由后端从 project_text 加载；
    # 粘贴/小文本场景仍然可以走旧路径（直接带 text 字段）
    text: str = Field("", max_length=200_000)
    model_id: str = Field(..., min_length=1, max_length=128)
    system_prompt: str = Field("", max_length=20_000)
    chunk_index: int = Field(0, ge=0, le=100_000)
    chunk_size: int = Field(0, ge=0, le=20_000)
    chunk_chapter: str = Field("", max_length=200)


class ProjectIn(BaseModel):
    """v26：项目创建 / 更新入参。

    - name：必填，保持 v20.2 行为；
    - description：可选；创建 / 更新时写入，旧库已默认空串。前端通过 name=""
      表达「不修改名称」（PUT 路径）。
    """
    name: str = Field("", max_length=200)
    description: str = Field("", max_length=2000)


# ---------- Fix-3：LLM 返回结构的校验 schema ----------

# v8-Fix-3：prototype pollution 黑名单（__proto__ / constructor / prototype 显式枚举）。
# Python `re` 不支持 lookahead/lookbehind，所以不能用 regex 实现负向前瞻，只能用
# field_validator + set lookup。validator 在 pattern 之后跑，确保 422 优先级清晰。
PROTO_POLLUTION_KEYWORDS = frozenset({"__proto__", "constructor", "prototype"})


def _reject_proto_keyword(v: str) -> str:
    """v8-Fix-3：拒绝 prototype pollution 黑名单。"""
    if v in PROTO_POLLUTION_KEYWORDS:
        raise ValueError(
            f"id/source/target 不能使用关键字 {v!r}（防 prototype pollution）"
        )
    return v


class AnalyzeNode(BaseModel):
    """Fix-4：主入口 AnalyzeNode 同样收紧 pattern——v5 验证指出导入端收紧但主端漏了。
    v8-Fix-3：叠加 _reject_proto_keyword 黑名单。
    v15：新增可选 chapter 字段，承载「第一章」「序」之类的小说章节标注。
    """
    model_config = ConfigDict(extra="ignore")
    id: str = Field(..., max_length=64, pattern=r"^[^\s,]+$")
    label: str = Field(..., max_length=100)
    sect: Optional[str] = Field(None, max_length=200)
    chapter: Optional[str] = Field("", max_length=200)

    _v_id = field_validator("id")(_reject_proto_keyword)


class AnalyzeEdge(BaseModel):
    model_config = ConfigDict(extra="ignore")
    source: str = Field(..., max_length=64, pattern=r"^[^\s,]+$")
    target: str = Field(..., max_length=64, pattern=r"^[^\s,]+$")
    label: str = Field("关联", max_length=200)
    chapter: Optional[str] = Field("", max_length=200)

    _v_source = field_validator("source")(_reject_proto_keyword)
    _v_target = field_validator("target")(_reject_proto_keyword)


class AnalyzeResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    nodes: List[AnalyzeNode] = Field(default_factory=list, max_length=2000)
    edges: List[AnalyzeEdge] = Field(default_factory=list, max_length=5000)


# ---------- Fix-4：导入接口的字段/体积限制 ----------
# pattern ^[^\s,]+$：排除空白 + 逗号（防 GROUP_CONCAT 注入污染 + __proto__ 等 JS 关键字）


class ImportProject(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field("导入项目", max_length=200)
    description: str = Field("", max_length=2000)


class ImportNode(BaseModel):
    """v8-Fix-3：叠加 _reject_proto_keyword 黑名单防 prototype pollution。"""
    model_config = ConfigDict(extra="ignore")
    id: str = Field(..., max_length=64, pattern=r"^[^\s,]+$")
    label: str = Field(..., max_length=100)
    sect: Optional[str] = Field(None, max_length=200)
    chapter: Optional[str] = Field("", max_length=200)

    _v_id = field_validator("id")(_reject_proto_keyword)


class ImportEdge(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    source: str = Field(..., max_length=64, pattern=r"^[^\s,]+$")
    target: str = Field(..., max_length=64, pattern=r"^[^\s,]+$")
    # 历史导出文件用 label，规范里叫 relationship，两者都接受
    label: str = Field("关联", max_length=200,
                       validation_alias=AliasChoices("label", "relationship"))
    chapter: Optional[str] = Field("", max_length=200)
    occurrence: Optional[int] = Field(1, ge=1)

    _v_source = field_validator("source")(_reject_proto_keyword)
    _v_target = field_validator("target")(_reject_proto_keyword)


class ImportPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    project: ImportProject = Field(default_factory=ImportProject)
    nodes: List[ImportNode] = Field(default_factory=list, max_length=2000)
    edges: List[ImportEdge] = Field(default_factory=list, max_length=5000)


# ==================== 备份加密 ====================


def _machine_id() -> str:
    """尽量稳定的本机标识：Windows 取注册表 MachineGuid，Linux 取 /etc/machine-id。"""
    try:
        if os.name == "nt":
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography",
                                0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                return winreg.QueryValueEx(k, "MachineGuid")[0]
        for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as f:
                    return f.read().strip()
    except Exception:
        pass
    return f"fallback-{secrets.token_hex(8)}"  # Fix-3：避免 node 泄露；fallback 用随机熵


def _backup_key() -> bytes:
    """由 hostname + machine-id 派生 Fernet 密钥：备份文件只能在本机解密。"""
    seed = f"storymap|{socket.gethostname()}|{_machine_id()}"
    return base64.urlsafe_b64encode(hashlib.sha256(seed.encode("utf-8")).digest())


def _encrypt_blob(payload: dict) -> str:
    from cryptography.fernet import Fernet
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return Fernet(_backup_key()).encrypt(raw).decode("ascii")


def _decrypt_blob(token: str) -> dict:
    from cryptography.fernet import Fernet
    raw = Fernet(_backup_key()).decrypt(token.encode("ascii"))
    return json.loads(raw.decode("utf-8"))


# ==================== Fix-1：LLM 调用（仅接受已注册 model_id） ====================


def _lookup_llm_model(model_id: str) -> dict:
    """Fix-1：从 llm_models 表查 api_key/base_url/upstream_model_name。
    model_id 必须是已注册行的主键（llm_models.id）。
    不存在 → 422（让前端明确知道是「未注册」而不是「LLM 失败」）。

    v9.1-Fix-3：走 _db_call_with_retry——库文件被外部删掉后（v9 实测的
    "no such table: llm_models"）自动重建 schema 重试一次，不再需要重启进程。
    注意重建后表是空的，查不到行仍然是 422 model_not_registered，这是对的：
    数据确实没了，不该假装成功。
    """
    row = _db_call_with_retry(
        lambda conn: conn.execute(
            "SELECT id, name, protocol, api_key, base_url, model_id FROM llm_models WHERE id=?",
            (model_id,),
        ).fetchone(),
        what="_lookup_llm_model",
    )
    if not row:
        raise HTTPException(status_code=422, detail={
            "status": "error",
            "error": "model_not_registered",
            "message": f"model_id={model_id!r} 未在 llm_models 中注册，请先在模型管理中添加",
        })
    return dict(row)


def _call_llm(llm_model_id: str, system_prompt: str, text: str) -> str:
    """Fix-1：仅接受已注册的 llm_model_id，base_url + api_key 全部从库中查。
    客户端绝无可能影响出站请求的目标 URL 或 Authorization 头。
    Fix-7：客户端级超时 + 最多 1 次内部重试。
    """
    cfg = _lookup_llm_model(llm_model_id)
    api_key = cfg["api_key"]
    base_url = cfg["base_url"]
    upstream_model = cfg["model_id"]

    client = OpenAI(api_key=api_key, base_url=base_url,
                    timeout=LLM_CLIENT_TIMEOUT, max_retries=1)
    resp = client.chat.completions.create(
        model=upstream_model,
        messages=[{"role": "system", "content": system_prompt},
                  {"role": "user", "content": text}],
    )
    return (resp.choices[0].message.content or "").strip()


def _parse_analyze_payload(raw: str) -> AnalyzeResponse:
    r"""提取 LLM 响应中的第一个合法 JSON 对象，必须过 Pydantic schema。

    v10.2 修复：原 regex `\{.*\}` 是贪婪匹配，遇到 <think>...</think>
    思考块或尾随说明文字时会吞掉全部内容，导致 json.loads 报 "Extra data"。
    改用 json.JSONDecoder().raw_decode() —— 原生理解 JSON 语法（含嵌套花括号），
    返回 (value, end_pos) 元组，自动跳过前缀空白。

    v14-Fix-5：宽容降级。当整块响应中只有个别 node/edge 字段缺失（如边缺
    target/source）时，整体 Validate 会让整个切片失败并浪费已消耗的 token。
    改为：先尝试整体校验；失败时进入逐项降级，仅丢弃不合法节点/边，保留
    其余已合法部分；只有在 nodes 与 edges 全部降级为空时才报错。
    """
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(raw):
        # 跳过非 JSON 字符（思考块、说明文字等）
        if raw[idx] == '{':
            try:
                data, _ = decoder.raw_decode(raw[idx:])
            except json.JSONDecodeError:
                idx += 1
                continue
            if not isinstance(data, dict):
                idx += 1
                continue
            try:
                return AnalyzeResponse.model_validate(data)
            except ValidationError:
                # 整体校验失败：进入逐项降级，丢弃不合法 node/edge
                kept_nodes, kept_edges, total = _salvage_partial_response(data)
                if total == 0:
                    # 整块响应根本没有 nodes/edges 字段可救，向上抛错让重试
                    raise
                if not kept_nodes and not kept_edges:
                    raise
                return AnalyzeResponse(nodes=kept_nodes, edges=kept_edges)
        idx += 1
    raise ValueError("响应中未找到 JSON 对象")


def _salvage_partial_response(data: dict) -> tuple[list, list, int]:
    """v14-Fix-5：逐项校验 nodes/edges，跳过不合法项。

    返回 (合法 nodes, 合法 edges, 总节点+总边数)。
    若总数为 0 或合法项为 0，调用方会继续向上抛错。
    """
    nodes_field = data.get("nodes") if isinstance(data, dict) else None
    edges_field = data.get("edges") if isinstance(data, dict) else None
    nodes_list = nodes_field if isinstance(nodes_field, list) else []
    edges_list = edges_field if isinstance(edges_field, list) else []

    kept_nodes: list = []
    for item in nodes_list:
        if not isinstance(item, dict):
            continue
        try:
            kept_nodes.append(AnalyzeNode.model_validate(item))
        except ValidationError:
            continue

    kept_edges: list = []
    for item in edges_list:
        if not isinstance(item, dict):
            continue
        try:
            kept_edges.append(AnalyzeEdge.model_validate(item))
        except ValidationError:
            continue

    return kept_nodes, kept_edges, len(nodes_list) + len(edges_list)


async def _analyze_with_llm(req: AnalyzeRequest) -> AnalyzeResponse:
    """Fix-7：显式 try/finally 释放信号量，杜绝超时路径下的计数泄漏。"""
    last_err = ""
    last_raw = ""
    system_prompt = req.system_prompt
    for attempt in range(2):
        await SEMAPHORE.acquire()
        try:
            raw = await asyncio.to_thread(
                _call_llm, req.model_id, system_prompt, req.text
            )
        finally:
            SEMAPHORE.release()
        last_raw = raw
        try:
            return _parse_analyze_payload(raw)
        except (ValueError, json.JSONDecodeError, ValidationError) as e:
            last_err = str(e)[:500]
            print(f"⚠️ JSON 校验失败（第 {attempt + 1} 次）: {last_err}")
            system_prompt = (
                f"{req.system_prompt}\n\n"
                "【重要】上一次输出无法解析，错误信息：\n"
                f"{last_err}\n"
                '必须只输出一个 JSON 对象，格式严格为：'
                '{"nodes":[{"id":"han_li","label":"韩立","sect":"黄枫谷"}],'
                '"edges":[{"source":"han_li","target":"nan_gong_wan","label":"道侣"}]}，'
                "不要输出 Markdown 代码块、解释文字或多余字段。"
            )
    raise HTTPException(status_code=422, detail={
        "status": "error",
        "error": "json_validation_failed",
        "message": last_err or "AI未返回标准JSON",
        "raw_preview": last_raw[:200],
    })


def _safe_json_loads(raw):
    """v26.3：解析存进 SQLite 的 JSON 字符串。空字符串/None/解析失败都安全返回 []。
    用于 chunks 列的回读——不应让一条坏记录拖垮整个 GET 响应。
    """
    if not raw:
        return []
    if isinstance(raw, (list, dict)):
        return raw
    try:
        v = json.loads(raw)
        return v if isinstance(v, (list, dict)) else []
    except (TypeError, ValueError):
        return []


def _load_project_text(pid: str) -> str:
    """v26.1：读取项目原文。导入大文本后分析/续跑都走这条路径；
    若项目从未导入原文 → 404。"""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT text FROM project_text WHERE project_id=?", (pid,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail={
                "status": "error", "error": "project_text_not_found",
                "message": f"项目 {pid!r} 尚未导入原文，可粘贴小文本或先调用 PUT /api/projects/{{pid}}/text",
            })
        return row['text']
    finally:
        conn.close()



# ==================== v26.2 章节识别（与 frontend/src/chapterSplitter.js 100% 对齐）====================
# 移植自 JS chapterSplitter.js，保证后端切片元数据与前端章节边界一致。
# 前端章节边界 = JS detectChapterRanges 输出（小文本/粘贴路径走老逻辑）。
# 大文本路径下，前端不再持有全文，必须由后端按相同规则计算 chunkMetas 与切片。

_ZH_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]

_CHAPTER_PATTERNS = [
    r"^[^\n]{0,30}?第([零〇一二三四五六七八九十百千]+)章[ 　 ]*([^\n\r]{0,30})",
    r"^[^\n]{0,30}?第([零〇一二三四五六七八九十百千]+)回[ 　 ]*([^\n\r]{0,30})",
    r"^[^\n]{0,30}?(序章|序言)[ 　 ]*([^\n\r]{0,30})?",
    r"^[^\n]{0,30}?序[ 　 ]*([^\n\r]{0,30})?",
    r"^[^\n]{0,30}?(楔子|引子|终章)[ 　 ]*([^\n\r]{0,30})?",
]


def _normalize_num(zh):
    """JS normalizeNum：第零章/〇 章 → 第一章（防 LLM 误读）。"""
    if not zh:
        return zh
    if zh in ("零", "〇"):
        return "一"
    return zh


def _format_chapter(match_text, group1, group2):
    """v26.4：与 JS chapterSplitter 保持一致。
    第N章/回 可能带《》目录 前缀，所以不再依赖 match_text 的开头位置，
    而是用正则重抓「第+数字+章/回」位置，再切片出标题。
    """
    import re as _re
    m = _re.search(r"第([零〇一二三四五六七八九十百千]+)([章回])", match_text)
    if m:
        num = _normalize_num(m.group(1))
        tag = m.group(2)
        title = match_text[m.end():].strip()
        return f"第{num}{tag} {title}" if title else f"第{num}{tag}"
    # 序/序章/序言：从去前缀后的 body 判 tag
    import re as _re2
    body = _re2.sub(r"^[^\n]{0,30}?", "", match_text)
    if body.startswith("序"):
        if body.startswith(("序章", "序言")):
            tag = body[:2]
        else:
            tag = "序"
        title = body[len(tag):].strip()
        return f"{tag} {title}" if title else tag
    # 楔子/引子/终章 等
    tag = body[:2]
    title = (group1 or "").strip()
    return f"{tag} {title}" if title else tag


def _detect_chapter_ranges(text):
    """JS detectChapterRanges 的 Python 移植。
    返回 [{chapter, start}]，按 start 升序去重；空文本返 []。
    """
    if not isinstance(text, str) or not text:
        return []
    import re as _re
    matches = []
    for pattern in _CHAPTER_PATTERNS:
        regex = _re.compile(pattern, _re.MULTILINE)
        for m in regex.finditer(text):
            chapter = _format_chapter(m.group(0), m.group(1), m.group(2) if m.lastindex and m.lastindex >= 2 else None)
            chapter = _re.sub(r"\s+", " ", chapter).strip()
            if not chapter:
                continue
            matches.append({"chapter": chapter, "start": m.start()})
    if not matches:
        return []
    matches.sort(key=lambda x: x["start"])
    dedup = []
    for m in matches:
        if not dedup or m["start"] > dedup[-1]["start"]:
            dedup.append(m)
    return dedup


def _get_chapter_for_chunk(chunk_index, chunk_size, ranges):
    """v26.4：与 JS getChapterForChunk 保持一致。
    chunkStart = chunk_index * chunk_size（与 for-loop 100% 对齐）。
    chunkStart 在第一个章节之前时（如文件头/前言），默认用第一章。
    """
    if not isinstance(chunk_index, int) or chunk_index < 0:
        return ""
    if not isinstance(chunk_size, int) or chunk_size <= 0:
        return ""
    if not ranges:
        return ""
    chunk_start = chunk_index * chunk_size
    # v26.4：chunkStart < 第一个章节 start 时默认用第一章
    if chunk_start < ranges[0]["start"]:
        return ranges[0]["chapter"]
    current = ""
    for r in ranges:
        if r["start"] <= chunk_start:
            current = r["chapter"]
        else:
            break
    return current


def _compute_chunk_index_by_chapter(ranges, chunk_start, chapter_from, chapter_to):
    """JS buildChunks 章节过滤：chunk 起点所在章节序号在 [from, to] 内才保留。
    chapter_from/to 为 0 或空表示不限。
    返回章节序号（1 起，0 表示无章节）。
    """
    if not ranges:
        return 0
    chapter_idx = 0
    for i, r in enumerate(ranges):
        if r["start"] <= chunk_start:
            chapter_idx = i + 1
        else:
            break
    return chapter_idx


class ProjectTextIn(BaseModel):
    """v26.1：PUT /api/projects/{pid}/text 入参。原文大小上限 64MB（与进度断点对齐）。"""
    model_config = ConfigDict(extra="ignore")
    text: str = Field(..., min_length=1, max_length=64_000_000)
    encoding: str = Field("utf-8", max_length=32)


class ProjectTextOut(BaseModel):
    """v26.1：GET /api/projects/{pid}/text 响应（前端预览用，按需取前 1-2 万字更轻）。"""
    projectId: str
    text: str
    chars: int
    encoding: str
    updatedAt: int


def _canonical_direction(source: str, target: str, label_of: dict):
    """按人物名字典序规范化边方向——A→B 和 B→A 落到同一条边。"""
    a = (label_of.get(source, source), source)
    b = (label_of.get(target, target), target)
    return (source, target) if a <= b else (target, source)


# ==================== 项目接口 ====================


@app.get("/api/projects")
def list_projs():
    conn = get_db()
    try:
        # 项目库卡片需要与项目详情中的可见图谱保持一致：边的统计排除
        # source/target 不存在的孤立边，避免列表数字与详情数字不一致。
        rows = conn.execute("""
            SELECT
                p.*,
                (
                    SELECT COUNT(*)
                    FROM nodes n
                    WHERE n.project_id = p.id
                ) AS nodeCount,
                (
                    SELECT COUNT(*)
                    FROM edges e
                    WHERE e.project_id = p.id
                      AND EXISTS (
                          SELECT 1 FROM nodes ns
                          WHERE ns.project_id = e.project_id AND ns.id = e.source
                      )
                      AND EXISTS (
                          SELECT 1 FROM nodes nt
                          WHERE nt.project_id = e.project_id AND nt.id = e.target
                      )
                ) AS edgeCount,
                COALESCE(
                    (SELECT MAX(updated_at) FROM project_text WHERE project_id = p.id),
                    (SELECT MAX(strftime('%s', created_at) * 1000) FROM edges WHERE project_id = p.id),
                    0
                ) AS lastUpdateAt
            FROM projects p
        """).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.post("/api/projects")
def add_proj(p: ProjectIn):
    """Fix-3：新建项目 ID 用 secrets.token_urlsafe(16)（22 字符 base64，128-bit 熵）。
    v20.2：INSERT 前先 SELECT 检查重名，命中返回 409。不改 DB schema（避免迁移风险）。
    v26：写入 description；命名列写以兼容后续 ALTER TABLE 扩列。
    """
    name = (p.name or '').strip()
    if not name:
        raise HTTPException(status_code=422, detail={"error": "name_required"})
    conn = get_db()
    try:
        # v20.2：应用层重名检查（避免并发同时插入同名）
        existing = conn.execute(
            "SELECT id FROM projects WHERE name = ?", (name,)
        ).fetchone()
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={"error": "duplicate_name", "name": name, "existing_id": existing["id"]},
            )
        pid = _new_project_id()
        # v26：命名列写，避免列位错位；description 默认空串。
        conn.execute(
            "INSERT INTO projects (id, name, description) VALUES (?, ?, ?)",
            (pid, name, p.description or ""),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": pid, "name": name}


@app.delete("/api/projects/{pid}")
def delete_proj(pid: str):
    """删除项目及其所有数据。Fix-3：兼容旧 hex ID 与新 22 字符 ID。"""
    # v27: cancel running engine tasks first; FK CASCADE will clean tasks rows.
    try:
        task_engine.cancel_tasks_for_project(pid)
    except Exception as _e:
        print(f"warn: cancel_tasks_for_project({pid}) failed: {_e}", flush=True)
    conn = get_db()
    try:
        conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        conn.execute("DELETE FROM nodes WHERE project_id=?", (pid,))
        conn.execute("DELETE FROM edges WHERE project_id=?", (pid,))
        conn.commit()
    finally:
        conn.close()
    return {"status": "success"}


@app.put("/api/projects/{pid}")
def rename_proj(pid: str, p: ProjectIn):
    """更新项目。Fix-3：兼容两种 ID 格式。
    v20.2：name 重名检查保留（排除自身），命中返回 409。
    v26：name 为空字符串时保持原值（不触发重名检查）；description 始终按调用方传入值更新。
    """
    name = (p.name or '').strip()
    description = p.description or ""
    conn = get_db()
    try:
        # v20.2：仅当 name 非空且发生改名时检查重名
        if name:
            existing = conn.execute(
                "SELECT id FROM projects WHERE name = ? AND id != ?", (name, pid)
            ).fetchone()
            if existing is not None:
                raise HTTPException(
                    status_code=409,
                    detail={"error": "duplicate_name", "name": name, "existing_id": existing["id"]},
                )
        # 命名列更新；name 为空 → 仅更新 description
        if name:
            conn.execute(
                "UPDATE projects SET name=?, description=? WHERE id=?",
                (name, description, pid),
            )
        else:
            conn.execute(
                "UPDATE projects SET description=? WHERE id=?",
                (description, pid),
            )
        conn.commit()
    finally:
        conn.close()
    return {"status": "success"}


@app.get("/api/projects/{pid}/data")
def get_data(pid: str):
    conn = get_db()
    try:
        nodes = [dict(r) for r in conn.execute("SELECT * FROM nodes WHERE project_id=?", (pid,)).fetchall()]
        edges = [dict(r) for r in conn.execute("SELECT * FROM edges WHERE project_id=?", (pid,)).fetchall()]
    finally:
        conn.close()

    node_ids = {n['id'] for n in nodes}
    valid_edges = []
    invalid_count = 0

    for edge in edges:
        if edge['source'] in node_ids and edge['target'] in node_ids:
            valid_edges.append(edge)
        else:
            invalid_count += 1
            print(f"⚠️ 发现无效边: {edge['id']}, source={edge['source']}, target={edge['target']}")

    if invalid_count > 0:
        print(f"✓ 过滤了 {invalid_count} 条无效边")

    return {"nodes": nodes, "edges": valid_edges}


# ==================== v26.1 项目原文（导入只上传一次） ====================

@app.put("/api/projects/{pid}/text", response_model=dict)
def put_project_text(pid: str, body: ProjectTextIn):
    """v26.1：上传项目原文。前端只持 meta；分析/续跑按 project_id 走 project_text。

    - 64MB 字节上限（与 task-progress 通道一致；中文 UTF-8 ≈ 2200w 字符）
    - 若项目不存在 → 404（FK 不会静默吃掉，由路由显式校验）
    - 重复 PUT：覆盖式 UPSERT
    """
    conn = get_db()
    try:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id=?", (pid,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail={
                "status": "error", "error": "project_not_found",
                "message": f"项目 {pid!r} 不存在",
            })
        chars = len(body.text)
        conn.execute('''
            INSERT INTO project_text (project_id, text, encoding, chars, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                text=excluded.text,
                encoding=excluded.encoding,
                chars=excluded.chars,
                updated_at=excluded.updated_at
        ''', (pid, body.text, body.encoding or "utf-8", chars, int(time.time() * 1000)))
        conn.commit()
    finally:
        conn.close()
    return {
        "status": "success",
        "projectId": pid,
        "chars": chars,
        "encoding": body.encoding,
        "updatedAt": int(time.time() * 1000),
    }


@app.get("/api/projects/{pid}/text", response_model=ProjectTextOut)
def get_project_text(pid: str):
    """v26.1：读取项目原文（按需拉取，前端不应默认持有全文）。"""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT text, encoding, chars, updated_at FROM project_text WHERE project_id=?",
            (pid,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "project_text_not_found",
            "message": f"项目 {pid!r} 尚未导入原文",
        })
    return ProjectTextOut(
        projectId=pid,
        text=row['text'],
        chars=row['chars'],
        encoding=row['encoding'],
        updatedAt=row['updated_at'],
    )


@app.get("/api/projects/{pid}/chunk-metas", response_model=dict)
def get_chunk_metas(pid: str, chunk_size: int = 500, chapter_from: int = 0, chapter_to: int = 0):
    """v26.2：大文本模式切片元数据。前端只持 meta，按 chunkIndex 增量请求。

    - 加载 project_text，按 Python 移植的章节识别（与 JS chapterSplitter.js 100% 对齐）扫描 chapters。
    - 计算 total = ceil(chars / chunk_size)；chapter_from/chapter_to 过滤后保留在范围内的 chunkIndex。
    - 返回 { status, total, chunkSize, chars, chunkMetas: [{chunkIndex, chapter}] }（不含文本）。
    - 项目不存在或未导入原文 → 404。
    """
    safe_chunk_size = max(1, min(int(chunk_size), 20000))
    safe_from = int(chapter_from) if chapter_from else 0
    safe_to = int(chapter_to) if chapter_to else 0

    conn = get_db()
    try:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id=?", (pid,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail={
                "status": "error", "error": "project_not_found",
                "message": f"项目 {pid!r} 不存在",
            })
        row = conn.execute(
            "SELECT text, chars FROM project_text WHERE project_id=?", (pid,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "project_text_not_found",
            "message": f"项目 {pid!r} 尚未导入原文",
        })

    full_text = row['text']
    chars = row['chars'] or len(full_text)
    ranges = _detect_chapter_ranges(full_text)
    total = (chars + safe_chunk_size - 1) // safe_chunk_size

    metas = []
    for idx in range(total):
        chunk_start = idx * safe_chunk_size
        chapter_idx = _compute_chunk_index_by_chapter(ranges, chunk_start, safe_from, safe_to)
        if safe_from and chapter_idx and chapter_idx < safe_from:
            continue
        if safe_to and chapter_idx and chapter_idx > safe_to:
            continue
        chapter = _get_chapter_for_chunk(idx, safe_chunk_size, ranges)
        metas.append({"chunkIndex": idx, "chapter": chapter})

    return {
        "status": "success",
        "projectId": pid,
        "total": total,
        "chunkSize": safe_chunk_size,
        "chars": chars,
        "chunkMetas": metas,
    }


# ==================== v26.3 项目失败切片（替换前端 localStorage）====================

class ProjectFailureIn(BaseModel):
    """v26.3：PUT /api/projects/{pid}/failure 入参。
    chunks 是 [{chunkIndex, message, status?}] 数组（JSON 序列化）。
    """
    model_config = ConfigDict(extra="ignore")
    chunkSize: int = Field(..., ge=1, le=20_000)
    totalChunks: int = Field(0, ge=0, le=10_000_000)
    chunks: List[Any] = Field(default_factory=list)
    chapterFrom: str = Field("", max_length=200)
    chapterTo: str = Field("", max_length=200)


@app.get("/api/projects/{pid}/failure", response_model=dict)
def get_project_failure(pid: str):
    """v26.3：读失败记录。无记录 → 404。
    不存在项目 → 404（FK 约束不会静默吞）。
    """
    conn = get_db()
    try:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id=?", (pid,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail={
                "status": "error", "error": "project_not_found",
                "message": f"项目 {pid!r} 不存在",
            })
        row = conn.execute(
            "SELECT chunk_size, total_chunks, chunks, chapter_from, chapter_to, updated_at FROM project_failures WHERE project_id=?",
            (pid,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "failure_not_found",
            "message": f"项目 {pid!r} 无失败记录",
        })
    return {
        "status": "success",
        "projectId": pid,
        "chunkSize": row['chunk_size'],
        "totalChunks": row['total_chunks'],
        "chunks": _safe_json_loads(row['chunks']),
        "chapterFrom": row['chapter_from'] or '',
        "chapterTo": row['chapter_to'] or '',
        "updatedAt": row['updated_at'],
    }


@app.put("/api/projects/{pid}/failure", response_model=dict)
def put_project_failure(pid: str, body: ProjectFailureIn):
    """v26.3：upsert 失败记录。
    - 不存在项目 → 404
    - chunks 序列化为 JSON 后存
    """
    conn = get_db()
    try:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id=?", (pid,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail={
                "status": "error", "error": "project_not_found",
                "message": f"项目 {pid!r} 不存在",
            })
        now = int(time.time() * 1000)
        chunks_json = json.dumps(body.chunks, ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO project_failures (project_id, chunk_size, total_chunks, chunks, chapter_from, chapter_to, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                chunk_size=excluded.chunk_size,
                total_chunks=excluded.total_chunks,
                chunks=excluded.chunks,
                chapter_from=excluded.chapter_from,
                chapter_to=excluded.chapter_to,
                updated_at=excluded.updated_at
            """,
            (pid, body.chunkSize, body.totalChunks, chunks_json, body.chapterFrom, body.chapterTo, now)
        )
        conn.commit()
    finally:
        conn.close()
    return {
        "status": "success",
        "projectId": pid,
        "chunkSize": body.chunkSize,
        "totalChunks": body.totalChunks,
        "chunks": body.chunks,
        "chapterFrom": body.chapterFrom,
        "chapterTo": body.chapterTo,
        "updatedAt": now,
    }


@app.delete("/api/projects/{pid}/failure")
def delete_project_failure(pid: str):
    """v26.3：清空失败记录。幂等——无记录也返回成功。
    不存在项目 → 404（保持与其他 /failure 端点一致）。
    """
    conn = get_db()
    try:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id=?", (pid,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail={
                "status": "error", "error": "project_not_found",
                "message": f"项目 {pid!r} 不存在",
            })
        conn.execute(
            "DELETE FROM project_failures WHERE project_id=?", (pid,)
        )
        conn.commit()
    finally:
        conn.close()
    return {"status": "success", "projectId": pid, "deleted": True}


@app.get("/api/projects/{pid}/chapters", response_model=dict)
def get_project_chapters(pid: str):
    """v26.4：返回项目的章节范围（用于前端章节选择器）。

    - 加载 project_text，按 Python 移植的章节识别扫描。
    - 返回 { status, projectId, ranges: [{chapter, start}], count }。
    - 项目不存在 → 404。
    - 项目无原文 → 200 但 ranges=[]（不报错，让前端兜底）。
    """
    conn = get_db()
    try:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id=?", (pid,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail={
                "status": "error", "error": "project_not_found",
                "message": f"项目 {pid!r} 不存在",
            })
        row = conn.execute(
            "SELECT text FROM project_text WHERE project_id=?", (pid,)
        ).fetchone()
    finally:
        conn.close()
    if not row or not row["text"]:
        return {"status": "success", "projectId": pid, "ranges": [], "count": 0}
    ranges = _detect_chapter_ranges(row["text"])
    return {
        "status": "success",
        "projectId": pid,
        "ranges": ranges,
        "count": len(ranges),
    }


def _grouped_duplicate_labels(conn, pid: str):
    """找出重名节点，并保证 id 拼接顺序稳定（方言兼容）。"""
    if sqlite3.sqlite_version_info >= (3, 44, 0):
        sql = """
            SELECT label, GROUP_CONCAT(id, ',' ORDER BY rowid) AS ids, COUNT(*) AS cnt
            FROM nodes
            WHERE project_id=?
            GROUP BY label
            HAVING cnt > 1
            ORDER BY label
        """
    else:
        sql = """
            SELECT label, GROUP_CONCAT(id) AS ids, COUNT(*) AS cnt
            FROM (SELECT label, id FROM nodes WHERE project_id=? ORDER BY label, rowid)
            GROUP BY label
            HAVING cnt > 1
            ORDER BY label
        """
    return conn.execute(sql, (pid,)).fetchall()


@app.post("/api/projects/{pid}/cleanup")
def cleanup_duplicates(pid: str):
    """清理重复节点和孤立边（含 A→B/B→A 反向重复合并）。"""
    conn = get_db()
    try:
        duplicates = _grouped_duplicate_labels(conn, pid)

        merged_count = 0
        for dup in duplicates:
            ids = dup['ids'].split(',')
            keep_id = ids[0]
            remove_ids = ids[1:]

            for old_id in remove_ids:
                conn.execute("UPDATE edges SET source=? WHERE source=? AND project_id=?", (keep_id, old_id, pid))
                conn.execute("UPDATE edges SET target=? WHERE target=? AND project_id=?", (keep_id, old_id, pid))
                conn.execute("DELETE FROM nodes WHERE id=? AND project_id=?", (old_id, pid))

            merged_count += len(remove_ids)

        orphan_edges = conn.execute("""
            SELECT e.id, e.source, e.target FROM edges e
            WHERE e.project_id=?
            AND (
                NOT EXISTS (SELECT 1 FROM nodes WHERE id=e.source AND project_id=e.project_id)
                OR NOT EXISTS (SELECT 1 FROM nodes WHERE id=e.target AND project_id=e.project_id)
            )
        """, (pid,)).fetchall()

        orphan_count = len(orphan_edges)
        for edge in orphan_edges:
            print(f"删除孤立边: {edge['id']}, source={edge['source']}, target={edge['target']}")
            conn.execute("DELETE FROM edges WHERE id=?", (edge['id'],))

        merged_edges = 0
        seen_pairs = {}
        rows = conn.execute(
            "SELECT rowid, id, source, target, label FROM edges WHERE project_id=? ORDER BY rowid",
            (pid,)
        ).fetchall()
        for r in rows:
            key = tuple(sorted((r['source'], r['target'])))
            if key not in seen_pairs:
                seen_pairs[key] = {"id": r['id'],
                                   "labels": [x.strip() for x in (r['label'] or '').split(' → ') if x.strip()]}
                continue
            keep = seen_pairs[key]
            for lbl in [x.strip() for x in (r['label'] or '').split(' → ') if x.strip()]:
                if lbl not in keep["labels"]:
                    keep["labels"].append(lbl)
            conn.execute("UPDATE edges SET label=? WHERE id=?", (' → '.join(keep["labels"]), keep["id"]))
            conn.execute("DELETE FROM edges WHERE id=?", (r['id'],))
            merged_edges += 1

        conn.commit()
    finally:
        conn.close()

    return {
        "status": "success",
        "merged_nodes": merged_count,
        "merged_edges": merged_edges,
        "removed_edges": orphan_count
    }


# ==================== 分析接口 ====================


@app.post("/api/projects/{pid}/analyze")
async def analyze(pid: str, req: AnalyzeRequest):
    """Fix-1：请求体只接 model_id（已注册 llm_models.id）+ text，不再接 base_url/api_key。
    model_id 必须是 _call_llm 可查到的行；缺失时由 _lookup_llm_model 抛 422。

    v8-Fix-5：错误码统一，与 /llm-models/test 同步：
      - model_not_registered → 422（HTTPException 由 _lookup_llm_model 抛出，重抛）
      - timeout             → 504（asyncio.wait 超时）
      - upstream_error      → 502（OpenAI/网络异常）
      - 其他                → 500（DB 写入异常等内部错误）
    """
    try:
        # 提前校验：避免拿不到密钥还白等超时
        _lookup_llm_model(req.model_id)

        # v26.2：text 为空时按 chunk_index × chunk_size 从 project_text 切片，
        # 避免把整篇原文塞进单次 LLM 调用（必然爆上下文/超时）。
        # chunk_chapter 为空时由后端按 ranges 推导。粘贴小文本兼容老路径（text 非空则不切片）。
        if not (req.text or "").strip():
            loaded = _load_project_text(pid)
            if not req.chunk_size or req.chunk_size <= 0:
                raise HTTPException(status_code=400, detail={
                    "status": "error", "error": "missing_chunk_size",
                    "message": "大文本模式必须带 chunk_size（前端用 /chunk-metas 拿）",
                })
            slice_start = req.chunk_index * req.chunk_size
            slice_end = slice_start + req.chunk_size
            chunk_text = loaded[slice_start:slice_end]
            # 章节前缀（与 JS splitTextWithChapterContext 完全一致）
            if not (req.chunk_chapter or "").strip():
                ranges = _detect_chapter_ranges(loaded)
                req = req.model_copy(update={"chunk_chapter": _get_chapter_for_chunk(req.chunk_index, req.chunk_size, ranges)})
            prefix = f"[当前章节：{req.chunk_chapter}]" if req.chunk_chapter else "[当前章节：未知]"
            sliced = f"{prefix}\n{chunk_text}" if chunk_text else prefix
            req = req.model_copy(update={"text": sliced})

        # Fix-7：整个请求（含重试）不超过 LLM_REQUEST_TIMEOUT；
        # 显式 acquire/release 配合 try/finally，超时路径也保证 semaphore 归零。
        task = asyncio.ensure_future(_analyze_with_llm(req))
        done, _ = await asyncio.wait({task}, timeout=LLM_REQUEST_TIMEOUT)
        if not done:
            task.cancel()
            raise HTTPException(status_code=504, detail={
                "status": "error", "error": "llm_timeout",
                "message": f"LLM 调用超过 {LLM_REQUEST_TIMEOUT:.0f}s 未返回",
            })
        data = task.result()
    except HTTPException:
        raise
    except Exception as e:
        # 上游 LLM 失败：401/403/网络/DNS/JSON 解析重试耗尽——明确告诉前端 502
        return JSONResponse(status_code=502, content={
            "status": "error", "error": "upstream_error",
            "message": f"LLM 调用失败: {type(e).__name__}: {str(e)[:500]}",
        })

    # v9.1-Fix-4：conn 在 try 之外获取，保证 finally 里一定有绑定；
    # 原来 get_db() 在 try 内部，任何中途异常都会让连接泄漏（WAL 下还会钉住 -wal 文件）。
    try:
        conn = get_db()
    except Exception as e:
        return JSONResponse(status_code=500, content={
            "status": "error", "error": "internal_error",
            "message": f"数据库连接失败: {type(e).__name__}: {str(e)[:500]}",
        })

    try:
        node_id_map = {}
        label_of = {}

        # v19：兜底章节名。LLM 经常漏填 chapter 字段（MiniMax 实测），
        # 这里用前端注入的 chunk_chapter 兜底——空字符串等价于「未标注章节」。
        fallback_chapter = (req.chunk_chapter or '').strip()

        for n in data.nodes:
            node_id = n.id.strip()
            label = n.label.strip()
            sect = (n.sect or '未知').strip()
            # v19：LLM 没填 chapter 时用 chunk_chapter 兜底
            chapter = (n.chapter or '').strip() or fallback_chapter

            existing = conn.execute(
                "SELECT id, sect, chapter FROM nodes WHERE project_id=? AND label=?",
                (pid, label)
            ).fetchone()

            if existing:
                final_id = existing['id']
                node_id_map[node_id] = final_id

                if sect and sect != '未知' and (not existing['sect'] or existing['sect'] == '未知'):
                    conn.execute(
                        "UPDATE nodes SET sect=? WHERE id=? AND project_id=?",
                        (sect, final_id, pid)
                    )
                if chapter and not existing['chapter']:
                    conn.execute(
                        "UPDATE nodes SET chapter=? WHERE id=? AND project_id=?",
                        (chapter, final_id, pid)
                    )
            else:
                final_id = node_id
                node_id_map[node_id] = final_id
                # v15-Fix-6：用命名列写入，避免 ALTER TABLE 追加列后位置错位。
                # 旧版 `VALUES (?,?,?,?,?)` 依赖 (id,label,sect,chapter,project_id)
                # 顺序，但实际表是 (id,label,sect,project_id,chapter)——结果把 chapter
                # 写进了 project_id 触发 FK 失败。
                conn.execute(
                    "INSERT OR IGNORE INTO nodes (id, label, sect, project_id, chapter) VALUES (?,?,?,?,?)",
                    (final_id, label, sect, pid, chapter)
                )
            label_of[final_id] = label

        for e in data.edges:
            source = node_id_map.get(e.source.strip(), e.source.strip())
            target = node_id_map.get(e.target.strip(), e.target.strip())
            label = (e.label or '关联').strip()
            # v19：LLM 没填 chapter 时用 chunk_chapter 兜底
            edge_chapter = (e.chapter or '').strip() or fallback_chapter
            if source == target:
                continue

            for nid in (source, target):
                if nid not in label_of:
                    row = conn.execute(
                        "SELECT label FROM nodes WHERE project_id=? AND id=?", (pid, nid)
                    ).fetchone()
                    if row:
                        label_of[nid] = row['label']

            existing = conn.execute(
                """SELECT id, label, chapter FROM edges
                   WHERE project_id=? AND ((source=? AND target=?) OR (source=? AND target=?))
                   ORDER BY rowid LIMIT 1""",
                (pid, source, target, target, source)
            ).fetchone()

            if existing:
                # v15：occurrence +1；首次出现的 chapter 回填。
                updates = ["occurrence = occurrence + 1"]
                params = []
                if edge_chapter and not existing['chapter']:
                    updates.append("chapter = ?")
                    params.append(edge_chapter)
                existing_labels = [x.strip() for x in existing['label'].split(' → ')]
                if label not in existing_labels:
                    new_label = existing['label'] + ' → ' + label
                    updates.append("label = ?")
                    params.append(new_label)
                params.append(existing['id'])
                conn.execute(
                    f"UPDATE edges SET {', '.join(updates)} WHERE id=?",
                    params
                )
            else:
                src, tgt = _canonical_direction(source, target, label_of)
                eid = f"edge_{secrets.token_hex(8)}"
                # v15-Fix-6：同节点表——用命名列写，规避 ALTER TABLE 之后的位置错位。
                conn.execute(
                    "INSERT INTO edges (id, source, target, label, project_id, chapter, occurrence) VALUES (?,?,?,?,?,?,?)",
                    (eid, src, tgt, label, pid, edge_chapter, 1)
                )

        conn.commit()
        return {"status": "success", "nodes": len(data.nodes), "edges": len(data.edges)}
    except HTTPException:
        raise
    except Exception as e:
        # v8-Fix-5：DB 写入异常等内部错误 → 500（之前返回 200 + status:error 是契约错误）
        return JSONResponse(status_code=500, content={
            "status": "error", "error": "internal_error",
            "message": f"保存分析结果失败: {type(e).__name__}: {str(e)[:500]}",
        })
    finally:
        conn.close()


# ==================== 导入导出 ====================


@app.get("/api/projects/{pid}/export")
async def export_p(pid: str, format: str = "encrypted"):
    """Fix-5：默认密文导出（{encrypted: True, data: "<fernet_blob>"}）。
    仅当客户端显式 ?format=plaintext 才返明文——防止备份云同步泄露人物关系。
    """
    conn = get_db()
    try:
        p = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if not p:
            raise HTTPException(status_code=404, detail={"error": "project_not_found"})
        nodes = [dict(r) for r in conn.execute("SELECT * FROM nodes WHERE project_id=?", (pid,)).fetchall()]
        edges = [dict(r) for r in conn.execute("SELECT * FROM edges WHERE project_id=?", (pid,)).fetchall()]
    finally:
        conn.close()

    payload = {"project": dict(p), "nodes": nodes, "edges": edges}

    if format == "plaintext":
        # 显式标志：返回明文（前端新代码显式启用）
        return {"encrypted": False, "project": payload["project"],
                "nodes": nodes, "edges": edges}

    # 默认密文
    try:
        token = await asyncio.to_thread(_encrypt_blob, payload)
    except Exception as e:
        # 加密失败时返 500 而不是降级到明文（安全默认）
        raise HTTPException(status_code=500, detail={
            "error": "encryption_failed",
            "message": f"备份加密失败，未生成明文: {type(e).__name__}",
        })
    return {"encrypted": True, "data": token, "format": "fernet-v1"}


@app.post("/api/projects/import")
async def import_p(request: Request):
    """v8-Fix-4：body 大小检查已上移到 limit_body_size 中间件（防 chunked 绕过），
    这里 request.body() 直接拿到的是中间件已读且缓存的字节，不再重复检查。"""
    body = await request.body()
    try:
        incoming = json.loads(body.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=422, detail={"error": "invalid_json"})
    if not isinstance(incoming, dict):
        raise HTTPException(status_code=422, detail={"error": "invalid_json"})

    # 加密备份自动解密（只有同一台机器能解开）
    if incoming.get("encrypted") and isinstance(incoming.get("data"), str):
        try:
            incoming = await asyncio.to_thread(_decrypt_blob, incoming["data"])
        except Exception as e:
            raise HTTPException(status_code=422, detail={
                "error": "decrypt_failed",
                "message": f"备份无法解密（可能来自其他设备）: {type(e).__name__}",
            })

    try:
        payload = ImportPayload.model_validate(incoming)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_payload",
            "message": "导入数据不合法或超出体积限制",
            "errors": json.loads(e.json())[:10],
        })

    conn = get_db()
    try:
        # Fix-3：导入也使用新算法生成项目 ID
        new_pid = _new_project_id()
        # v26：携带 description 落库；老文件缺字段时回落空串。
        conn.execute(
            "INSERT INTO projects (id, name, description) VALUES (?, ?, ?)",
            (new_pid, payload.project.name, payload.project.description or ""),
        )

        # Fix-4：节点入库先按 label 去重，建立 LLM id -> 库内最终 id 的映射
        label_of = {}
        for n in payload.nodes:
            label = (n.label or '').strip() or n.id
            chapter = (n.chapter or '').strip()
            existing = conn.execute(
                "SELECT id FROM nodes WHERE project_id=? AND label=?",
                (new_pid, label)
            ).fetchone()
            if existing:
                final_id = existing['id']
            else:
                final_id = n.id
                # v15-Fix-6：导入路径同样用命名列写，规避 ALTER TABLE 之后的位置错位
                # ——和 analyze 路径同一份事故。
                conn.execute(
                    "INSERT OR IGNORE INTO nodes (id, label, sect, project_id, chapter) VALUES (?,?,?,?,?)",
                    (final_id, n.label, n.sect or '', new_pid, chapter)
                )
            label_of[n.id] = final_id

        # Fix-10：导入时也调用 _canonical_direction 规范化边方向——A→B/B→A/A→B 入库后只剩 1 条
        seen_pairs = {}
        for e in payload.edges:
            src_raw = e.source
            tgt_raw = e.target
            if src_raw == tgt_raw:
                continue
            src = label_of.get(src_raw, src_raw)
            tgt = label_of.get(tgt_raw, tgt_raw)
            if src == tgt:
                continue

            # 规范化方向：按人物名排序
            canonical_src, canonical_tgt = _canonical_direction(src, tgt, {nid: nid for nid in (src, tgt)})
            key = tuple(sorted((canonical_src, canonical_tgt)))
            if key in seen_pairs:
                continue
            seen_pairs[key] = True

            eid = f"edge_{secrets.token_hex(8)}"
            edge_chapter = (e.chapter or '').strip()
            # v15-Fix-6：命名列写，规避 ALTER TABLE 之后的位置错位。
            conn.execute(
                "INSERT INTO edges (id, source, target, label, project_id, chapter, occurrence) VALUES (?,?,?,?,?,?,?)",
                (eid, canonical_src, canonical_tgt, e.label, new_pid, edge_chapter, e.occurrence or 1)
            )

        conn.commit()
    finally:
        conn.close()
    return {"status": "success", "project_id": new_pid,
            "nodes": len(payload.nodes), "edges": len(payload.edges)}


# ==================== LLM 模型管理接口 ====================


# ==================== 炼化进度断点接口（v25-fix：本地持久化替换 localStorage） ====================


class TaskProgressIn(BaseModel):
    """PUT /api/task-progress/{project_id} 入参。承载整篇原文，最大 64MB。

    字段命名沿用前端 camelCase，路由内手工转 snake_case 喂给 progress_repository，
    避免别名带来的可读性损失。extra="ignore" 兜底，防止 LLMManager 误把无关字段塞进来。
    """
    model_config = ConfigDict(extra="ignore")
    active: bool = True
    timestamp: Optional[int] = Field(None, ge=0)
    # totalChunks / lastCompleted 给到 1000w 上限：百万字长卷 ≈ 200w 切片，再放大 5 倍。
    totalChunks: int = Field(..., ge=0, le=10_000_000)
    lastCompleted: int = Field(0, ge=0, le=10_000_000)
    # text：64MB 字节上限下，最坏 UTF-8 中文字符约 2200w；Field 限 3000w 给余量。
    # text 改为可空（断点续跑不再依赖前端持有原文；为空时由后端从 project_text 加载）。
    # 保留 30MB 上限：粘贴/小文本兼容老路径 + 兼容性读（已有记录仍可读）。
    text: str = Field("", max_length=30_000_000)
    chunkSize: int = Field(..., ge=1, le=20_000)
    concurrency: int = Field(3, ge=1, le=8)
    llmModelName: str = Field("", max_length=200)
    chapterFrom: str = Field("", max_length=200)
    chapterTo: str = Field("", max_length=200)


class TaskProgressPatch(BaseModel):
    """PATCH /api/task-progress/{project_id} 入参：仅更新 lastCompleted。"""
    model_config = ConfigDict(extra="ignore")
    lastCompleted: int = Field(..., ge=0, le=10_000_000)


class TaskProgressListItem(BaseModel):
    """GET /api/task-progress 列表项：不含 text（轻量，避免一次拉全文）。"""
    projectId: str
    active: bool
    timestamp: int
    totalChunks: int
    lastCompleted: int
    chunkSize: int
    concurrency: int
    llmModelName: str
    chapterFrom: str
    chapterTo: str


class TaskProgressDetail(BaseModel):
    """GET /api/task-progress/{id} 单条详情：含 text。"""
    projectId: str
    active: bool
    timestamp: int
    totalChunks: int
    lastCompleted: int
    text: str
    chunkSize: int
    concurrency: int
    llmModelName: str
    chapterFrom: str
    chapterTo: str


def _normalize_project_id(pid) -> str:
    """统一字符串/数字 project_id 表示：路由层 + 业务层都会走这里。"""
    if pid is None:
        return ""
    return str(pid).strip()


@app.get("/api/task-progress", response_model=List[TaskProgressListItem])
def list_task_progress():
    """列出全部 active 进度断点（轻量，不含 text）。刷新初始化时用。"""
    conn = get_db()
    try:
        return progress_repository.list_progress(conn)
    finally:
        conn.close()


@app.get("/api/task-progress/{project_id}", response_model=TaskProgressDetail)
def get_task_progress(project_id: str):
    """单条进度详情（含 text）。用户点击「继续」时再拉，避免列表阶段拉大文本。"""
    pid = _normalize_project_id(project_id)
    if not pid:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    conn = get_db()
    try:
        row = progress_repository.get_progress(conn, pid)
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return row


@app.put("/api/task-progress/{project_id}")
def put_task_progress(project_id: str, payload: TaskProgressIn):
    """落盘或更新炼化进度断点（含整篇原文）。

    专用 64MB 通道（见 _body_size_limit_for）。任务开始时必须先成功落盘，
    再发送 LLM analyze 请求 —— 否则刷新就丢进度。
    """
    pid = _normalize_project_id(project_id)
    if not pid:
        raise HTTPException(status_code=422, detail={"error": "invalid_project_id"})

    conn = get_db()
    try:
        # 先确认项目存在。FK 也会拒绝，但 FK 失败信息对前端不够友好（500 + 长 trace）。
        # 显式 404 让前端知道「项目已被删除/不该继续」。
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id=?", (pid,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail={
                "status": "error",
                "error": "project_not_found",
                "message": f"项目 {pid!r} 不存在，无法写入进度断点",
            })

        progress_repository.upsert_progress(conn, pid, {
            "total_chunks": payload.totalChunks,
            "last_completed": payload.lastCompleted,
            "text": payload.text,
            "chunk_size": payload.chunkSize,
            "concurrency": payload.concurrency,
            "llm_model_name": payload.llmModelName,
            "chapter_from": payload.chapterFrom,
            "chapter_to": payload.chapterTo,
        })
        conn.commit()
    finally:
        conn.close()
    return {"status": "success", "projectId": pid}


@app.patch("/api/task-progress/{project_id}")
def patch_task_progress(project_id: str, payload: TaskProgressPatch):
    """只更新 lastCompleted；progress_repository.update_progress 用 MAX 兜单调不回退。

    业务约束：
      - 不重传整篇原文（已写在 PUT 里，刷新时再补）
      - 单调不回退（避免乱序到达导致 lastCompleted 倒退）
      - 不存在的记录返 404
    """
    pid = _normalize_project_id(project_id)
    if not pid:
        raise HTTPException(status_code=422, detail={"error": "invalid_project_id"})
    conn = get_db()
    try:
        ok = progress_repository.update_progress(conn, pid, payload.lastCompleted)
        if not ok:
            raise HTTPException(status_code=404, detail={"error": "not_found"})
        conn.commit()
    finally:
        conn.close()
    return {"status": "success", "projectId": pid}


@app.delete("/api/task-progress/{project_id}")
def delete_task_progress(project_id: str):
    """删除某项目的进度断点（任务完成/用户放弃时调用）。"""
    pid = _normalize_project_id(project_id)
    if not pid:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    conn = get_db()
    try:
        progress_repository.delete_progress(conn, pid)
        conn.commit()
    finally:
        conn.close()
    return {"status": "success", "projectId": pid}


class LLMModel(BaseModel):
    """v8-Fix-1：api_key 改 Optional[str]=None。
    - POST：必传（业务上注册新模型必须提供密钥），缺失时由 add_llm_model 抛 422。
    - PUT：可选，缺失/空串 → 保留库中既有 api_key（修 LLMManager.handleEdit 契约：
      前端 LLMModelOut 不含 api_key，PUT body 中该字段是 undefined）。"""
    model_config = ConfigDict(protected_namespaces=())
    name: str = Field(..., max_length=100)
    protocol: str = Field(..., max_length=32)  # openai, volcano, bailian
    api_key: Optional[str] = Field(None, max_length=512)
    base_url: str = Field(..., max_length=512)
    model_id: str = Field(..., max_length=200)
    is_default: bool = False


class LLMModelOut(BaseModel):
    """对外响应模型——不含 api_key 字段，密钥永远不会离开后端。"""
    model_config = ConfigDict(protected_namespaces=())
    id: str
    name: str
    protocol: str
    base_url: str
    model_id: str
    is_default: bool = False
    created_at: Optional[str] = None
    has_api_key: bool = False


# v8-Fix-2：test 端点仍然只接受 model_id 决定后端查哪条记录（base_url+api_key 永远从
# 库中查），但 schema 用 extra="ignore" 允许前端附带 UI 字段（name/description 等），
# 不再 422。客户端若塞 api_key/base_url 进 body，会被 schema 直接忽略，不会流到
# _lookup_llm_model / _call_llm——攻击面仍封闭。
class TestLLMRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    model_id: str = Field(..., min_length=1, max_length=128,
                          description="已注册的 llm_models.id（不是上游 model name）")


def _model_row_to_out(row) -> dict:
    d = dict(row)
    d["has_api_key"] = bool(d.pop("api_key", None))
    d["is_default"] = bool(d.get("is_default"))
    if d.get("created_at") is not None:
        d["created_at"] = str(d["created_at"])
    return d


@app.get("/api/llm-models", response_model=List[LLMModelOut],
         response_model_exclude={"api_key"})
def list_llm_models():
    """获取所有 LLM 模型配置（不含 api_key）"""
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM llm_models ORDER BY is_default DESC, created_at DESC").fetchall()
    finally:
        conn.close()
    return [_model_row_to_out(r) for r in rows]


@app.post("/api/llm-models")
def add_llm_model(model: LLMModel):
    """添加新的 LLM 模型配置（密钥入库；响应不回显）。
    v8-Fix-1：api_key 必传——Optional 是为了 PUT 路径「保留原密钥」的契约，
    新建模型不提供 api_key 是业务错误，必须 422 而非 IntegrityError。"""
    if not model.api_key:
        raise HTTPException(status_code=422, detail={
            "status": "error", "error": "api_key_required",
            "message": "新建模型必须提供 api_key（PUT 才允许为空以保留原密钥）",
        })
    conn = get_db()
    try:
        model_id = f"llm_{secrets.token_hex(8)}"

        if model.is_default:
            conn.execute("UPDATE llm_models SET is_default = 0")

        conn.execute(
            "INSERT INTO llm_models (id, name, protocol, api_key, base_url, model_id, is_default) VALUES (?,?,?,?,?,?,?)",
            (model_id, model.name, model.protocol, model.api_key, model.base_url, model.model_id, 1 if model.is_default else 0)
        )
        conn.commit()
    finally:
        conn.close()
    return {"status": "success", "id": model_id}


@app.put("/api/llm-models/{model_id}")
def update_llm_model(model_id: str, model: LLMModel):
    """更新 LLM 模型配置。
    v8-Fix-1：api_key 为 None / 空串 → 保留库中既有密钥；非空 → 更新。
    修 LLMManager.handleEdit：前端 LLMModelOut 剥了 api_key，PUT body 中该字段是
    undefined/缺失，被 Pydantic 解析为 None；以前会因为 required str 422 missing。
    """
    conn = get_db()
    try:
        if model.is_default:
            conn.execute("UPDATE llm_models SET is_default = 0")

        api_key = model.api_key
        if not api_key:  # None 或 "" → 保留原密钥
            row = conn.execute("SELECT api_key FROM llm_models WHERE id=?", (model_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail={
                    "status": "error", "error": "model_not_found",
                    "message": f"model_id={model_id!r} 不存在",
                })
            api_key = row["api_key"]

        conn.execute(
            "UPDATE llm_models SET name=?, protocol=?, api_key=?, base_url=?, model_id=?, is_default=? WHERE id=?",
            (model.name, model.protocol, api_key, model.base_url, model.model_id, 1 if model.is_default else 0, model_id)
        )
        conn.commit()
    finally:
        conn.close()
    return {"status": "success"}


@app.delete("/api/llm-models/{model_id}")
def delete_llm_model(model_id: str):
    conn = get_db()
    try:
        conn.execute("DELETE FROM llm_models WHERE id=?", (model_id,))
        conn.commit()
    finally:
        conn.close()
    return {"status": "success"}


@app.post("/api/llm-models/test")
async def test_llm_model(req: TestLLMRequest):
    """Fix-1 + Fix-9：测试 LLM 连接。
    - 必须传已注册的 model_id（TestLLMRequest.extra="forbid" 阻止 base_url/api_key 注入）。
    - model_id 未注册 → 422（明确语义：让前端去「模型管理」先注册）。
    - LLM 上游错误 → 502（Bad Gateway）。
    - 超时 → 504（Gateway Timeout）。
    """
    # Fix-1：先校验 model_id，缺失就 422，杜绝「客户端用攻击者 base_url + 后端密钥」外发
    cfg = _lookup_llm_model(req.model_id)
    api_key = cfg["api_key"]
    base_url = cfg["base_url"]
    protocol = cfg["protocol"]
    upstream_model = cfg["model_id"]

    headers = {}
    if protocol == "volcano":
        headers = {"Authorization": f"Bearer {api_key}"}
    elif protocol == "bailian":
        headers = {"Authorization": f"Bearer {api_key}", "X-DashScope-SSE": "enable"}

    def _do_test():
        client = OpenAI(
            api_key=api_key,
            base_url=base_url,
            default_headers=headers if headers else None,
            timeout=LLM_CLIENT_TIMEOUT,
            max_retries=1,
        )
        return client.chat.completions.create(
            model=upstream_model,
            messages=[{"role": "user", "content": "你好，请回复'测试成功'"}],
            max_tokens=50
        )

    # Fix-7：semaphore 显式 try/finally
    await SEMAPHORE.acquire()
    try:
        try:
            resp = await asyncio.wait_for(asyncio.to_thread(_do_test), timeout=LLM_CLIENT_TIMEOUT + 10)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail={
                "status": "error", "error": "llm_timeout",
                "message": f"LLM 连接超过 {LLM_CLIENT_TIMEOUT + 10:.0f}s 未返回",
            })
        except Exception as e:
            # Fix-9：上游 LLM 错误（401/403/网络/DNS）应返 502，不是 200 也不是 500。
            # 这里不再吞掉异常，而是明确告诉前端「上游失败」。
            raise HTTPException(status_code=502, detail={
                "status": "error", "error": "upstream_error",
                "message": f"上游 LLM 调用失败: {type(e).__name__}: {str(e)[:300]}",
            })
    finally:
        SEMAPHORE.release()

    content = (resp.choices[0].message.content or "").strip()
    return {
        "status": "success",
        "message": "连接成功",
        "response": content,
        "model": resp.model
    }


@app.get("/api/llm-models/default", response_model=Optional[LLMModelOut],
         response_model_exclude={"api_key"})
def get_default_model():
    """获取默认 LLM 模型（不含 api_key）"""
    conn = get_db()
    try:
        model = conn.execute("SELECT * FROM llm_models WHERE is_default=1 LIMIT 1").fetchone()
    finally:
        conn.close()
    if model:
        return _model_row_to_out(model)
    return None


@app.get("/api/llm-models/{model_id}", response_model=LLMModelOut,
         response_model_exclude={"api_key"})
def get_llm_model(model_id: str):
    """获取单个 LLM 模型配置（不含 api_key）"""
    conn = get_db()
    try:
        model = conn.execute("SELECT * FROM llm_models WHERE id=?", (model_id,)).fetchone()
    finally:
        conn.close()
    if not model:
        raise HTTPException(status_code=404, detail={"error": "model_not_found"})
    return _model_row_to_out(model)


# ==================== v27 后端任务引擎接口 ====================

class TaskCreateIn(BaseModel):
    """POST /api/projects/{pid}/tasks 入参。"""
    model_config = ConfigDict(extra="ignore")
    kind: str = Field("analyze", pattern="^(analyze|continue|retry)$")
    chunk_size: int = Field(..., ge=1, le=20_000)
    concurrency: int = Field(3, ge=1, le=8)
    llm_model_id: str = Field(..., min_length=1, max_length=128)
    system_prompt: str = Field("", max_length=20_000)
    chapter_from: str = Field("", max_length=200)
    chapter_to: str = Field("", max_length=200)
    # continue / retry 用：续跑起点（retry 忽略——用失败索引）。
    start_index: int = Field(0, ge=0, le=10_000_000)
    # retry 用：原任务 chunkSize（用于 remap）。
    old_chunk_size: int = Field(0, ge=0, le=20_000)
    # retry 用：失败索引（remap 后落到新 chunkSize 下）。
    failure_indexes: List[int] = Field(default_factory=list)


def _project_text_or_404(pid: str) -> str:
    """Load project_text or 404. Caller responsible for closing."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT text FROM project_text WHERE project_id=?", (pid,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "project_text_not_found",
            "message": f"project {pid!r} has no imported text; PUT /api/projects/{{pid}}/text first",
        })
    return row["text"]


def _llm_model_name_or_empty(model_id: str) -> str:
    try:
        cfg = _lookup_llm_model(model_id)
        return cfg.get("name", "")
    except Exception:
        return ""


def _task_row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    failed = _safe_json_loads(d.get("failed_indexes") or "[]")
    d["failedIndexes"] = list(failed) if isinstance(failed, list) else []
    d["chapterFrom"] = d.get("chapter_from") or ""
    d["chapterTo"] = d.get("chapter_to") or ""
    d["llmModelId"] = d.get("llm_model_id") or ""
    d["modelName"] = d.get("model_name") or ""
    d["systemPrompt"] = d.get("system_prompt") or ""
    d["rateLimitCount"] = d.get("rate_limit_count", 0)
    d["degraded"] = bool(d.get("degraded", 0))
    d["projectId"] = d.get("project_id")
    d["taskId"] = d.get("id")
    d["kind"] = d.get("kind")
    d["status"] = d.get("status")
    d["chunkSize"] = d.get("chunk_size")
    d["concurrency"] = d.get("concurrency")
    d["totalChunks"] = d.get("total_chunks")
    d["completed"] = d.get("completed", 0)
    d["successCount"] = d.get("success_count", 0)
    d["failedCount"] = d.get("failed_count", 0)
    d["lastCompleted"] = d.get("last_completed", 0)
    d["createdAt"] = d.get("created_at")
    d["updatedAt"] = d.get("updated_at")
    d["startedAt"] = d.get("started_at")
    d["finishedAt"] = d.get("finished_at")
    d["error"] = d.get("error") or ""
    return d


def _ensure_project_exists(pid: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "project_not_found",
            "message": f"project {pid!r} not found",
        })


@app.post("/api/projects/{pid}/tasks", response_model=dict)
async def create_task_endpoint(pid: str, body: TaskCreateIn):
    """Create a new analysis task and launch the engine.

    409 if any task in queued/running/paused exists for the project.
    """
    _ensure_project_exists(pid)

    # 409: existing active task for this project.
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id, status FROM tasks WHERE project_id=? "
            "AND status IN ('queued','running','paused') LIMIT 1",
            (pid,),
        ).fetchone()
    finally:
        conn.close()
    if existing:
        raise HTTPException(status_code=409, detail={
            "status": "error", "error": "task_already_active",
            "taskId": existing["id"],
            "message": f"project {pid!r} already has an active task",
        })

    # Load project text (404 if missing).
    project_text = _project_text_or_404(pid)

    # Load LLM model config (validate up front).
    try:
        _lookup_llm_model(body.llm_model_id)
    except HTTPException:
        raise

    # Compute chunk metas.
    ranges = _detect_chapter_ranges(project_text)
    chunk_size = body.chunk_size
    chars = len(project_text)
    total_chunks = (chars + chunk_size - 1) // chunk_size
    chunk_indexes = list(range(total_chunks))
    chapter_from_i = int(body.chapter_from) if body.chapter_from else 0
    chapter_to_i = int(body.chapter_to) if body.chapter_to else 0

    if chapter_from_i or chapter_to_i:
        filtered = []
        for idx in chunk_indexes:
            ci = _compute_chunk_index_by_chapter(ranges, idx * chunk_size, chapter_from_i, chapter_to_i)
            if chapter_from_i and ci and ci < chapter_from_i:
                continue
            if chapter_to_i and ci and ci > chapter_to_i:
                continue
            filtered.append(idx)
        chunk_indexes = filtered

    # Build task row.
    task_id = task_engine.new_task_id()
    now = task_engine.now_iso()
    start_index = 0
    retry_remapped = None
    kind = body.kind

    if kind == "retry":
        old_size = body.old_chunk_size or chunk_size
        if not body.failure_indexes:
            raise HTTPException(status_code=400, detail={
                "status": "error", "error": "missing_failure_indexes",
                "message": "retry requires failure_indexes",
            })
        # remap and intersect with available chunk_indexes
        remapped = task_engine.remap_indexes(body.failure_indexes, old_size, chunk_size)
        available = set(chunk_indexes)
        retry_remapped = [i for i in remapped if i in available]
        if not retry_remapped:
            raise HTTPException(status_code=400, detail={
                "status": "error", "error": "no_matching_chunks",
                "message": "retry indexes do not match any current chunk",
            })
        total_for_task = len(retry_remapped)
    elif kind == "continue":
        start_index = body.start_index
        if start_index >= len(chunk_indexes):
            raise HTTPException(status_code=400, detail={
                "status": "error", "error": "no_remaining",
                "message": "no remaining chunks to continue",
            })
        total_for_task = len(chunk_indexes) - start_index
    else:  # analyze
        total_for_task = len(chunk_indexes)

    model_name = _llm_model_name_or_empty(body.llm_model_id)

    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO tasks (
                id, project_id, kind, status,
                chunk_size, concurrency, total_chunks,
                completed, success_count, failed_count,
                failed_indexes, last_completed,
                chapter_from, chapter_to,
                llm_model_id, system_prompt, model_name,
                error, rate_limit_count, degraded,
                created_at, updated_at, started_at, finished_at
            ) VALUES (
                ?, ?, ?, 'queued',
                ?, ?, ?,
                0, 0, 0,
                '[]', ?,
                ?, ?,
                ?, ?, ?,
                '', 0, 0,
                ?, ?, NULL, NULL
            )""",
            (
                task_id, pid, kind,
                chunk_size, body.concurrency, total_for_task,
                start_index,
                body.chapter_from or "", body.chapter_to or "",
                body.llm_model_id, body.system_prompt or "", model_name,
                now, now,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    # Register runner.
    runner = task_engine.RunnerState(
        task_id=task_id,
        project_id=pid,
        concurrency=body.concurrency,
        effective_concurrency=body.concurrency,
    )
    task_engine.RUNNERS[task_id] = runner

    # Spawn the runner coroutine on the event loop.
    runner.asyncio_task = task_engine.submit_run_task(
        task_id=task_id,
        pid=pid,
        kind=kind,
        chunk_size=chunk_size,
        concurrency=body.concurrency,
        llm_model_id=body.llm_model_id,
        system_prompt=body.system_prompt or "",
        model_name=model_name,
        chapter_from=body.chapter_from or "",
        chapter_to=body.chapter_to or "",
        total_chunks=len(chunk_indexes),
        chunk_indexes=chunk_indexes,
        project_text=project_text,
        ranges=ranges,
        start_index=start_index,
        retry_remapped=retry_remapped,
    )

    return {"status": "success", "taskId": task_id, "totalChunks": total_for_task}


@app.get("/api/projects/{pid}/tasks", response_model=dict)
def list_tasks_endpoint(pid: str):
    """List all tasks for a project (light: no full text)."""
    _ensure_project_exists(pid)
    rows = task_engine.list_tasks_for_project(pid)
    items = [_task_row_to_dict(r) for r in rows]
    return {"status": "success", "projectId": pid, "tasks": items}


class TaskPatchIn(BaseModel):
    """PATCH /api/projects/{pid}/tasks/{tid} 入参。"""
    model_config = ConfigDict(extra="ignore")
    action: str = Field(..., pattern="^(pause|resume|cancel|set_concurrency)$")
    concurrency: int = Field(0, ge=0, le=8)


@app.patch("/api/projects/{pid}/tasks/{tid}", response_model=dict)
def patch_task_endpoint(pid: str, tid: str, body: TaskPatchIn):
    """Action dispatcher: pause|resume|cancel|set_concurrency."""
    _ensure_project_exists(pid)
    row = task_engine.fetch_task_row(tid)
    if not row:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "task_not_found",
            "message": f"task {tid!r} not found",
        })
    if row["project_id"] != pid:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "task_project_mismatch",
            "message": f"task {tid!r} does not belong to project {pid!r}",
        })

    action = body.action
    if action == "pause":
        ok = task_engine.pause_task(tid)
    elif action == "resume":
        ok = task_engine.resume_task(tid)
    elif action == "cancel":
        ok = task_engine.cancel_task(tid)
    elif action == "set_concurrency":
        ok = task_engine.set_task_concurrency(tid, body.concurrency)
    else:
        ok = False

    if not ok:
        raise HTTPException(status_code=409, detail={
            "status": "error", "error": "action_not_allowed",
            "message": f"action {action!r} not allowed in current task state",
        })
    return {"status": "success", "taskId": tid, "action": action}


@app.delete("/api/projects/{pid}/tasks/{tid}", response_model=dict)
def delete_task_endpoint(pid: str, tid: str):
    """Cancel + delete a task row."""
    _ensure_project_exists(pid)
    row = task_engine.fetch_task_row(tid)
    if not row:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "task_not_found",
            "message": f"task {tid!r} not found",
        })
    if row["project_id"] != pid:
        raise HTTPException(status_code=404, detail={
            "status": "error", "error": "task_project_mismatch",
            "message": f"task {tid!r} does not belong to project {pid!r}",
        })

    # If still active, cancel first.
    task_engine.cancel_task(tid)
    conn = get_db()
    try:
        conn.execute("DELETE FROM tasks WHERE id=?", (tid,))
        conn.commit()
    finally:
        conn.close()
    return {"status": "success", "taskId": tid}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("STORYMAP_HOST", "127.0.0.1"),
                port=int(os.environ.get("STORYMAP_PORT", "28000")))
