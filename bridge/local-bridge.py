# -*- coding: utf-8 -*-
"""
钉钉办公交互中心 - 本地桥服务
让平台网页（GitHub Pages）直接调用本机 DWS 命令，实现免回填直连。
安全设计：
- 仅监听 127.0.0.1（外部网络无法访问）
- CORS 仅放行平台域名
- 命令白名单：只允许本文件中列出的 DWS 子命令，参数逐个传递（无 shell 注入面）
"""
import http.server
import json
import shutil
import subprocess
import urllib.parse
from socketserver import ThreadingMixIn

PORT = 8765
ALLOWED_ORIGINS = {
    "https://lpllonglong520.github.io",
    "http://localhost:63342",
    "http://127.0.0.1:63342",
    "null",
}

# DWS 独立核心（不走宿主 shim，需先完成一次独立登录）
import os
DWS_CORE = os.path.join(
    os.path.expanduser("~"), ".qwenworkcn", "bin", "ext", "dws-core-windows-amd64.exe"
)


def base_cmd():
    return [DWS_CORE]


def run_dws(args, timeout=180):
    """执行白名单内的 dws 命令，返回 (stdout, returncode, stderr)"""
    cmd = base_cmd() + args + ["--format", "json"]
    env = dict(os.environ)
    env["QWORK_SHIM_ROUTE"] = "dws"
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout, encoding="utf-8", errors="replace", env=env,
        )
        return p.stdout, p.returncode, p.stderr
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "error": "本地桥执行超时"}), 1, ""
    except FileNotFoundError:
        return json.dumps({"success": False, "error": "未找到 dws-core，请确认千问办公已安装"}), 1, ""


def build_route(path, q):
    """将 HTTP 请求映射为白名单 dws 参数列表；未知路由返回 None"""
    if path == "/api/ping":
        return None  # 特殊处理
    if path == "/api/find-user":
        if q.get("mobile"):
            return ["contact", "user", "search-mobile", "--mobile", q["mobile"][0]]
        return ["aisearch", "person", "--query", q.get("name", [""])[0], "--dimension", "name"]
    if path == "/api/dm-send":
        return ["chat", "+dm", "--to", q.get("to", [""])[0],
                "--content", q.get("content", [""])[0], "--yes"]
    if path == "/api/todo-create":
        args = ["todo", "task", "create",
                "--title", q.get("title", [""])[0],
                "--executors", q.get("userId", [""])[0]]
        due = q.get("due", [""])[0].strip()
        if due:
            if len(due) == 16:  # "2026-09-29T20:26"
                due += ":00+08:00"
            args += ["--due", due]
        pri = q.get("priority", ["20"])[0]
        args += ["--priority", pri]
        return args
    if path == "/api/todo-related":
        return ["todo", "+get-related-tasks"]
    if path == "/api/todo-done":
        return ["todo", "+todo-done", "--task", q.get("title", [""])[0], "--yes"]
    if path == "/api/minutes-search":
        args = ["minutes", "+search", "--scope", "all"]
        if q.get("start"):
            args += ["--start", q["start"][0]]
        if q.get("end"):
            args += ["--end", q["end"][0]]
        return args + ["--page-all"]
    if path == "/api/minutes-detail":
        return ["minutes", "+detail", "--ids", q.get("ids", [""])[0],
                "--artifacts", "basic,summary,keywords"]
    if path == "/api/record-start":
        return ["minutes", "+record-start", "--yes"]
    if path == "/api/record-stop":
        return ["minutes", "+record-stop", "--yes"]
    return None


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass  # 静默访问日志

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return False
        self.send_header("Access-Control-Allow-Origin", origin or "https://lpllonglong520.github.io")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        if not self._cors():
            self.send_response(403)
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self.send_response(403)
            self.end_headers()
            return

        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        route = build_route(parsed.path, q)

        if parsed.path == "/api/ping":
            body = {"ok": True, "core": DWS_CORE}
        elif route is None:
            body = {"ok": False, "error": "未知接口: " + parsed.path}
        else:
            stdout, code, stderr = run_dws(route)
            try:
                data = json.loads(stdout)
            except Exception:
                data = {"success": False, "raw": stdout[:2000], "stderr": stderr[:500]}
            body = {"ok": code == 0, "data": data}

        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", origin or "https://lpllonglong520.github.io")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


class ThreadingHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print("=" * 56)
    print("  钉钉办公交互中心 · 本地桥服务")
    print("  监听地址: http://127.0.0.1:%d" % PORT)
    print("  dws-core: %s" % DWS_CORE)
    print("  首次使用请先运行「首次登录.bat」完成独立登录")
    print("  请保持本窗口开启；关闭窗口即停止直连服务")
    print("=" * 56)
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), BridgeHandler).serve_forever()
    except OSError as e:
        print("启动失败：", e)
        print("（若端口被占用，说明本地桥已在运行）")
        input("按回车退出…")
