#!/usr/bin/env python3
"""Verify stream terminal usage through a real Core process and SQLite."""

import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


spec = importlib.util.spec_from_file_location(
    "config_http", Path(__file__).parents[1] / "v8-config-http" / "run.py"
)
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


def stream_payload(case):
    frame = {
        "id": "audit-stream", "object": "chat.completion.chunk",
        "model": "served-model", "choices": [{"index": 0, "delta": {"content": "ok"}}],
    }
    chunks = ["data: " + json.dumps(frame) + "\n\n"]
    if case != "failure_without_usage":
        chunks.append("data: " + json.dumps({
            **frame, "choices": [],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
        }) + "\n\n")
    if case == "success":
        chunks.append("data: [DONE]\n\n")
    elif case not in ("disconnect_after_usage", "clean_eof_after_usage"):
        chunks.append('event: error\ndata: {"error":{"message":"fixture failure","type":"server_error","code":"fixture_error"}}\n\n')
    return "".join(chunks).encode()


def run_case(binary, output, case):
    wire = stream_payload(case)
    upstream_requests = []

    class Upstream(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            upstream_requests.append({"path": self.path, "body": json.loads(body)})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            # A short HTTP body produces a transport error; a complete body
            # without DONE exercises the native OpenAI EOF compatibility.
            self.send_header("Content-Length", str(len(wire) + (100 if case == "disconnect_after_usage" else 0)))
            self.end_headers()
            self.wfile.write(wire)
            self.wfile.flush()

        def log_message(self, *_args):
            pass

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    worker = threading.Thread(target=upstream.serve_forever, daemon=True)
    worker.start()
    port = support.free_port()
    root = output / case
    auth_dir = root / "auths"
    auth_dir.mkdir(parents=True, exist_ok=True)
    config = support.legacy_config(port, auth_dir) + f'''
request-retry: 0
max-retry-credentials: 1
disable-cooling: true
openai-compatibility:
  - name: audit-provider
    base-url: http://127.0.0.1:{upstream.server_port}/v1
    api-key-entries:
      - api-key: fixture-provider-key
    models:
      - name: audit-model
'''
    process = support.ScenarioProcess(binary, output, case, config, usage_enabled=True)
    result = {"case": case, "passed": False}
    try:
        manager = process.start(port)
        client = support.HTTPClient(f"http://127.0.0.1:{port}", support.API_KEY_A, process.transcript)
        status, body = client.request("POST", "/v1/chat/completions", {
            "model": "audit-model", "stream": True,
            "messages": [{"role": "user", "content": "fixture"}],
        }, timeout=20)
        (root / "client-response.json").write_text(json.dumps({"status": status, "body": body}, indent=2))
        deadline = time.monotonic() + 15
        rows = []
        while time.monotonic() < deadline:
            db = root / "usage.sqlite"
            if db.exists():
                with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as connection:
                    connection.row_factory = sqlite3.Row
                    rows = [dict(row) for row in connection.execute(
                        "SELECT request_id,model,response_model,input_tokens,output_tokens,total_tokens,failed "
                        "FROM usage_events ORDER BY id"
                    )]
            if rows:
                break
            time.sleep(0.1)
        (root / "usage-rows.json").write_text(json.dumps(rows, indent=2))
        support.require(len(rows) == 1, f"expected one persisted event: {rows}")
        row = rows[0]
        support.require(row["response_model"] == "served-model", f"response model lost: {row}")
        support.require(bool(row["failed"]) == (case not in ("success", "clean_eof_after_usage")), f"wrong terminal outcome: {row}")
        expected_tokens = 0 if case == "failure_without_usage" else 12
        support.require(row["total_tokens"] == expected_tokens, f"observed tokens lost: {row}")
        support.require(len(upstream_requests) == 1, f"unexpected retries: {upstream_requests}")
        status, events = manager.request("GET", "/v0/management/usage/events?after_id=0&limit=10")
        support.require(status == 200, f"persisted usage API failed: {status}")
        (root / "usage-api.json").write_text(json.dumps(events, indent=2))
        result.update(passed=True, row=row)
    except Exception:
        result["error"] = traceback.format_exc()
    finally:
        process.stop()
        upstream.shutdown()
        upstream.server_close()
        worker.join(timeout=5)
        (root / "upstream-requests.json").write_text(json.dumps(upstream_requests, indent=2))
        (root / "upstream-response.sse").write_bytes(wire)
        result["artifacts"] = process.artifacts()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--scenario", choices=["success", "failure_after_usage", "failure_without_usage", "disconnect_after_usage", "clean_eof_after_usage"])
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    cases = [args.scenario] if args.scenario else ["success", "failure_after_usage", "failure_without_usage", "disconnect_after_usage", "clean_eof_after_usage"]
    results = [run_case(args.binary.resolve(), args.output.resolve(), case) for case in cases]
    receipt = {"binarySha256": support.sha256_file(args.binary), "passed": all(r["passed"] for r in results), "results": results}
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"passed": receipt["passed"], "receipt": str(args.output / "receipt.json")}))
    raise SystemExit(0 if receipt["passed"] else 1)


if __name__ == "__main__":
    main()
