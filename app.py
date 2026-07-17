import asyncio
import itertools
import json
import os
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from src.agent import AgentRunner


ROOT_DIR = Path(__file__).resolve().parent
RUNTIME_DIR = ROOT_DIR / "runtime"
FIXTURE_DIR = ROOT_DIR / "fixtures"
SANDBOX_DIR = ROOT_DIR / "windowsXP-simulation"

load_dotenv(ROOT_DIR / ".env")

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "3100"))
ALLOWED_TARGET_HOSTS = {
    value.strip().lower()
    for value in os.getenv("ALLOWED_TARGET_HOSTS", "127.0.0.1,localhost").split(",")
    if value.strip()
}
ALLOWED_ORIGINS = {
    value.strip().rstrip("/").lower()
    for value in os.getenv(
        "ALLOWED_ORIGINS",
        f"http://127.0.0.1:{PORT},http://localhost:{PORT}",
    ).split(",")
    if value.strip()
}

RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
FIXTURE_DIR.mkdir(parents=True, exist_ok=True)


class RuntimeState:
    def __init__(self) -> None:
        self.clients: set[asyncio.Queue] = set()
        self.recent_events: list[dict] = []
        self.runner: AgentRunner | None = None
        self.runner_task: asyncio.Task | None = None
        self.last_status = {
            "state": "idle",
            "message": "Ready",
            "step": 0,
            "frameUrl": None,
        }
        self.lock = asyncio.Lock()
        self.event_ids = itertools.count(1)

    def current_status(self) -> dict:
        return self.runner.get_status() if self.runner else dict(self.last_status)

    def is_active(self) -> bool:
        return bool(
            self.runner
            and self.runner.get_status()["state"] in {"queued", "running", "stopping"}
        )

    async def broadcast(self, event: dict) -> None:
        enriched = {
            **event,
            "id": f"{time.time_ns()}-{next(self.event_ids)}",
        }
        if event.get("type") != "frame":
            self.recent_events.append(enriched)
            self.recent_events = self.recent_events[-100:]

        for queue in tuple(self.clients):
            if queue.full():
                with suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            with suppress(asyncio.QueueFull):
                queue.put_nowait(enriched)

    async def start(self, start_url: str, goal: str, use_screenshot: bool) -> tuple[bool, str | None]:
        async with self.lock:
            if self.is_active():
                return False, "An Agent run is already active"

            self._remove_previous_frame()
            self.recent_events = []
            runner = AgentRunner(
                start_url=start_url,
                goal=goal,
                use_screenshot=use_screenshot,
                runtime_dir=RUNTIME_DIR,
                upload_dir=FIXTURE_DIR,
                on_event=self.broadcast,
            )
            self.runner = runner
            self.runner_task = asyncio.create_task(self._drive(runner))
            return True, None

    async def _drive(self, runner: AgentRunner) -> None:
        await runner.run()
        async with self.lock:
            self.last_status = runner.get_status()
            if self.runner is runner:
                self.runner = None
                self.runner_task = None

    async def stop(self) -> tuple[bool, str | None]:
        async with self.lock:
            if not self.is_active() or not self.runner:
                return False, "There is no active run"
            await self.runner.stop()
            return True, None

    async def shutdown(self) -> None:
        task = self.runner_task
        if self.runner:
            await self.runner.stop()
        if task:
            try:
                await asyncio.wait_for(task, timeout=10)
            except TimeoutError:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    def _remove_previous_frame(self) -> None:
        frame_url = self.current_status().get("frameUrl")
        if not frame_url:
            return
        frame_name = Path(urlsplit(frame_url).path).name
        if frame_name.startswith("frame-") and frame_name.endswith(".jpg"):
            (RUNTIME_DIR / frame_name).unlink(missing_ok=True)


state = RuntimeState()


@asynccontextmanager
async def lifespan(_: FastAPI):
    for frame in RUNTIME_DIR.glob("frame-*.jpg"):
        frame.unlink(missing_ok=True)
    yield
    await state.shutdown()


app = FastAPI(title="Agent Playwright Demo", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_ORIGINS),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/sandbox", include_in_schema=False)
async def sandbox_redirect() -> RedirectResponse:
    return RedirectResponse(url="/sandbox/", status_code=307)


@app.get("/sandbox/", include_in_schema=False)
async def sandbox() -> FileResponse:
    return FileResponse(SANDBOX_DIR / "demo.html", media_type="text/html")


app.mount(
    "/sandbox/img",
    StaticFiles(directory=SANDBOX_DIR / "img"),
    name="sandbox-images",
)


def json_response(status_code: int, body: dict) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=body,
        headers={"Cache-Control": "no-store"},
    )


def validate_origin(request: Request) -> str | None:
    origin = request.headers.get("origin")
    if not origin:
        return None
    if origin.rstrip("/").lower() not in ALLOWED_ORIGINS:
        return "Cross-origin mutation requests are not allowed"
    return None


def validate_start_url(value: object) -> tuple[str | None, str | None]:
    if not isinstance(value, str):
        return None, "Start URL is invalid"
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None, "Only HTTP and HTTPS URLs are allowed"
    host = parsed.hostname.lower()
    if "*" not in ALLOWED_TARGET_HOSTS and host not in ALLOWED_TARGET_HOSTS:
        return None, f"Target host is not allowed: {host}"
    return value.strip(), None


@app.get("/")
async def index() -> JSONResponse:
    return json_response(
        200,
        {
            "name": "Agent Playwright Demo",
            "mode": "api-with-sandbox",
            "docs": "/docs",
            "openapi": "/openapi.json",
            "endpoints": {
                "sandbox": "GET /sandbox",
                "health": "GET /api/health",
                "status": "GET /api/status",
                "events": "GET /api/events",
                "run": "POST /api/run",
                "stop": "POST /api/stop",
                "frame": "GET /runtime/{frame_name}",
            },
        },
    )


@app.get("/runtime/{frame_name}")
async def runtime_frame(frame_name: str) -> Response:
    current_url = state.current_status().get("frameUrl")
    allowed_name = Path(urlsplit(current_url).path).name if current_url else None
    if frame_name != allowed_name or not frame_name.startswith("frame-") or not frame_name.endswith(".jpg"):
        return json_response(404, {"error": "Not found"})
    frame_path = RUNTIME_DIR / frame_name
    if not frame_path.is_file():
        return json_response(404, {"error": "Not found"})
    return FileResponse(frame_path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/health")
async def health() -> JSONResponse:
    configured = all(
        os.getenv(name)
        for name in ("OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL")
    )
    return json_response(200, {"ok": True, "agentConfigured": configured})


@app.get("/api/status")
async def status() -> JSONResponse:
    return json_response(200, state.current_status())


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    queue: asyncio.Queue = asyncio.Queue(maxsize=128)
    state.clients.add(queue)
    history = list(state.recent_events)
    snapshot = {"type": "snapshot", "status": state.current_status()}

    async def event_stream():
        try:
            for event in history:
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n"

            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            state.clients.discard(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/run")
async def run_agent(request: Request) -> JSONResponse:
    origin_error = validate_origin(request)
    if origin_error:
        return json_response(403, {"ok": False, "error": origin_error})
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return json_response(415, {"ok": False, "error": "Content-Type must be application/json"})
    chunks = []
    body_size = 0
    async for chunk in request.stream():
        body_size += len(chunk)
        if body_size > 32 * 1024:
            return json_response(413, {"ok": False, "error": "Request body is too large"})
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks).decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return json_response(400, {"ok": False, "error": "Request body must be valid JSON"})
    if not isinstance(body, dict):
        return json_response(400, {"ok": False, "error": "Request body must be an object"})

    goal = body.get("goal")
    if not isinstance(goal, str) or not goal.strip():
        return json_response(400, {"ok": False, "error": "Goal is required"})
    start_url, url_error = validate_start_url(body.get("startUrl"))
    if url_error:
        return json_response(400, {"ok": False, "error": url_error})

    ok, error = await state.start(
        start_url=start_url,
        goal=goal.strip()[:1000],
        use_screenshot=body.get("useScreenshot") is not False,
    )
    return json_response(202 if ok else 400, {"ok": ok, **({"error": error} if error else {})})


@app.post("/api/stop")
async def stop_agent(request: Request) -> JSONResponse:
    origin_error = validate_origin(request)
    if origin_error:
        return json_response(403, {"ok": False, "error": origin_error})
    ok, error = await state.stop()
    return json_response(200 if ok else 400, {"ok": ok, **({"error": error} if error else {})})


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
