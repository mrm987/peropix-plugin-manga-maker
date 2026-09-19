"""One-shot text planning via installed CLIs, independent of the app's live chat session."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
import threading
import time
import signal
from pathlib import Path

# Reasoning levels both CLIs accept: `claude --help` (2.1.156) and Codex models_cache.json
# supported_reasoning_levels (0.147.0). Same list the app's own CLI settings offer.
EFFORTS = ["max", "xhigh", "high", "medium", "low"]


def command(settings: dict, output: Path) -> list[str]:
    exe = settings.get("exe") or ""
    if not exe:
        raise ValueError("CLI를 찾지 못했습니다. 설치 후 만화 기획 LLM 설정을 새로고침해 주세요.")
    if Path(exe).suffix.lower() in {".cmd", ".bat", ".ps1"}:
        raise ValueError("CLI의 실제 실행 파일을 찾지 못했습니다. PeroPix CLI 설정에서 설치 상태를 확인해 주세요.")
    if settings["agent"] == "codex":
        args = [exe, "exec", "--skip-git-repo-check", "--sandbox", "read-only",
                "--ephemeral", "--color", "never", "--json", "-o", str(output),
                "-c", "features.shell_tool=false", "-c", 'web_search="disabled"']
    elif settings["agent"] == "claude-code":
        args = [exe, "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config",
                "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk", "--no-session-persistence",
                # No setting sources: otherwise the CLI loads every CLAUDE.md above cwd plus the user's
                # memory and output style, and inherits the user's global effort level. Measured
                # 2026-09-14: 128,740 input tokens per page under PeroPix3, 8,284 with this flag.
                "--setting-sources", ""]
    else:
        raise ValueError("지원하지 않는 CLI입니다.")
    if settings.get("model"):
        args += ["--model", settings["model"]]
    if settings.get("effort"):
        if settings["agent"] == "codex":
            args += ["-c", f'model_reasoning_effort="{settings["effort"]}"']
        else:
            args += ["--effort", settings["effort"]]
    if settings["agent"] == "codex":
        args.append("-")
    return args


def terminate(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       capture_output=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()


def run(settings: dict, system: str, messages: list, root: Path, cancel=None, timeout=600) -> dict:
    cancel = cancel or threading.Event()
    if cancel.is_set():
        raise asyncio.CancelledError
    root.mkdir(parents=True, exist_ok=True)
    # TemporaryDirectory owns only disposable transport files, never generated images/projects.
    with tempfile.TemporaryDirectory(prefix="request-", dir=root) as name:
        cwd = Path(name)
        output = cwd / "response.txt"
        prompt = ("This is a text-only manga planning request, not a coding task. Do not use tools, "
                  "inspect files, or modify the app. Return the requested JSON directly.\n\n" + system +
                  "\n\nConversation:\n" + json.dumps(messages, ensure_ascii=False))
        process = subprocess.Popen(command(settings, output), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", cwd=cwd,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                   start_new_session=os.name != "nt")
        deadline = time.monotonic()+timeout
        first = True
        try:
            while True:
                if cancel.is_set():
                    raise asyncio.CancelledError
                if time.monotonic() >= deadline:
                    raise ValueError("CLI 기획이 10분 안에 끝나지 않아 종료했습니다. 모델과 CLI 로그인 상태를 확인해 주세요.")
                try:
                    stdout, stderr = process.communicate(input=prompt if first else None, timeout=.1)
                    break
                except subprocess.TimeoutExpired:
                    first = False
            if cancel.is_set():
                raise asyncio.CancelledError
        finally:
            if process.poll() is None:
                try:
                    terminate(process)
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=5)
        if process.returncode:
            detail = (stderr or stdout or "출력 없음").strip()[-2000:]
            return {"error": f"{settings['agent']} 종료 코드 {process.returncode}: {detail}"}
        if settings["agent"] == "codex":
            if not output.is_file():
                return {"error": "Codex CLI가 최종 답변을 남기지 않았습니다. CLI 로그인과 모델 사용 권한을 확인해 주세요."}
            return {"text": output.read_text(encoding="utf-8").strip()}
        try:
            payload = json.loads(stdout)
        except ValueError:
            return {"error": "Claude Code의 JSON 응답을 읽지 못했습니다: " + stdout[-1000:]}
        if payload.get("is_error"):
            return {"error": str(payload.get("result") or payload.get("errors") or "Claude Code 실행 실패")}
        structured = payload.get("structured_output")
        return {"text": json.dumps(structured, ensure_ascii=False) if structured is not None else payload.get("result", "")}


async def chat(settings: dict, system: str, messages: list, root: Path) -> dict:
    # Windows uvicorn reload uses SelectorEventLoop; subprocess runs in a worker thread.
    cancel = threading.Event()
    worker = asyncio.create_task(asyncio.to_thread(run, settings, system, messages, root, cancel))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        cancel.set()
        def consume(task):
            if not task.cancelled():
                task.exception()
        worker.add_done_callback(consume)
        raise
