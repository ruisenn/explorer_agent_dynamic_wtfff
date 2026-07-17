# Agent API

Python + FastAPI + Playwright 实现的浏览器 Agent 服务。Agent 会重复观察目标页面、
调用 OpenAI-compatible `/chat/completions` 规划单步动作，并在失败后重新观察和规划。

## 安装

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

默认配置可以使用本机 Microsoft Edge。若不配置 `PLAYWRIGHT_CHANNEL`，请安装
Playwright Chromium：

```powershell
.\.venv\Scripts\python.exe -m playwright install chromium
```

参考 `.env配置模板` 创建 `.env` 并填写模型配置。

## 启动

```powershell
.\.venv\Scripts\python.exe app.py
```

接口发现：<http://127.0.0.1:3000/>
沙箱 <http://127.0.0.1:3000/sandbox/>
OpenAPI 文档：<http://127.0.0.1:3000/docs>

## 接口

| 方法 | 路径 | 功能 |
|---|---|---|
| `GET` | `/api/health` | 服务和模型配置状态 |
| `GET` | `/api/status` | 当前或最近一次任务状态 |
| `GET` | `/api/events` | SSE 实时事件与浏览器帧通知 |
| `POST` | `/api/run` | 启动浏览器 Agent |
| `POST` | `/api/stop` | 停止当前任务 |
| `GET` | `/runtime/{frame_name}` | 获取当前任务浏览器 JPEG |

启动任务示例：

```json
{
  "startUrl": "http://127.0.0.1:8000/target",
  "goal": "填写并提交表单",
  "useScreenshot": true
}
```

允许的模型动作包括 `click`、`fill`、`select`、`check`、`upload`、`wait` 和
`finish`。上传文件需预先放入 `fixtures`，模型只能通过安全的 `fileId` 选择文件。

未来前端如果运行在其他端口，需要把其完整 Origin 加入 `.env` 的
`ALLOWED_ORIGINS`。目标网站主机则加入 `ALLOWED_TARGET_HOSTS`。

应用状态保存在进程内存中，
只运行一个 Uvicorn worker。

## 测试！！！

```powershell
.\.venv\Scripts\python.exe -m unittest discover -v
```
+ OpenAI-compatible `/chat/completions` Agent 
+ DOM 摘要、可选截图感知、实时浏览器画面和事件记录。
+ 运行和停止控制。

