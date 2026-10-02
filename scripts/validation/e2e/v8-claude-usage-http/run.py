#!/usr/bin/env python3
"""Verify Claude apply_patch translation and terminal accounting over HTTP/SQLite."""

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

PATCH = "*** Begin Patch\n*** Add File: fixture.txt\n+hello\n*** End Patch"
CASES = ["native_json_success", "responses_nonstream_success", "responses_nonstream_invalid",
         "responses_stream_success", "responses_stream_invalid", "responses_stream_invalid_eof",
         "openai_nonstream_success", "openai_nonstream_invalid", "openai_stream_invalid_eof",
         "catalog_policy_alias"]


def verify_catalog_alias(manager, client, root):
    bindings = support.require_single_binding(manager)
    support.require_status(manager, "POST", "/v0/management/api-key-policies", 201, {
        "keyRef": bindings["items"][0]["keyRef"], "displayName": "catalog fixture",
        "initialProfile": {"name": "alias", "providers": ["claude"], "models": ["audit-claude"],
                           "mappings": [{"source": "policy-patch-alias", "target": "audit-claude"}]},
    })
    status = support.require_status(manager, "GET", "/v0/management/api-key-policy-status", 200)
    support.require_status(manager, "PUT", "/v0/management/api-key-policy-takeover", 200, {
        "enabled": True, "configuredGeneration": status["configuredGeneration"],
        "policyGeneration": status["policyGeneration"],
    })
    catalog = support.require_status(client, "GET", "/v1/models?client_version=0.153.4", 200)
    (root / "catalog.json").write_text(json.dumps(catalog, indent=2))
    by_id = {model["slug"]: model for model in catalog["models"]}
    support.require(set(by_id) == {"audit-claude", "policy-patch-alias"}, f"policy model visibility changed: {by_id}")
    canonical, alias = by_id["audit-claude"], by_id["policy-patch-alias"]
    support.require(canonical["apply_patch_tool_type"] == "freeform", "fixture target lacks executor capability")
    support.require(alias["apply_patch_tool_type"] == "freeform", "policy alias lost target apply_patch capability")
    support.require(alias.get("cpa_capabilities") == canonical.get("cpa_capabilities"), "policy alias lost web-search capability")
    support.require("EffectiveID" not in json.dumps(catalog), "internal policy identity leaked")


def upstream_payload(case):
    if case.startswith("openai_"):
        arguments = json.dumps({"input": 42} if "invalid" in case else {"input": PATCH})
        call = {"id": "call_fixture", "type": "function", "function": {"name": "apply_patch", "arguments": arguments}}
        response = {"id": "chat_fixture", "object": "chat.completion", "model": "served-model",
                    "choices": [{"index": 0, "message": {"role": "assistant", "tool_calls": [call]},
                                 "finish_reason": "tool_calls"}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}
        if "_stream_" not in case:
            return json.dumps(response).encode(), "application/json"
        call["index"] = 0
        response["object"] = "chat.completion.chunk"
        response["choices"] = [{"index": 0, "delta": {"role": "assistant", "tool_calls": [call]}, "finish_reason": None}]
        return ("data: " + json.dumps(response) + "\n\n").encode(), "text/event-stream"
    message = {
        "id": "msg_fixture", "type": "message", "role": "assistant", "model": "served-model",
        "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 2},
    }
    if case == "native_json_success":
        return json.dumps(message).encode(), "application/json"
    args = {"input": 42} if "invalid" in case else {"input": PATCH}
    partial = json.dumps(args)
    if case.endswith("_eof"):
        partial = partial[:-1]
    events = [
        {"type": "message_start", "message": {**message, "content": [], "stop_reason": None}},
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "tool_use", "id": "call_fixture", "name": "apply_patch", "input": {}}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "input_json_delta", "partial_json": partial}},
    ]
    if not case.endswith("_eof"):
        events += [
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 2}},
            {"type": "message_stop"},
        ]
    return "".join("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
                   for event in events).encode(), "text/event-stream"


def run_case(binary, output, case):
    wire, content_type = upstream_payload(case)
    upstream_requests = []

    class Upstream(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            upstream_requests.append({"path": self.path, "body": json.loads(body)})
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(wire)))
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
    config = support.legacy_config(port, auth_dir) + '''
request-retry: 0
max-retry-credentials: 1
disable-cooling: true
'''
    if case.startswith("openai_"):
        config += f'''
openai-compatibility:
  - name: audit-provider
    base-url: http://127.0.0.1:{upstream.server_port}/v1
    api-key-entries:
      - api-key: fixture-provider-key
    models:
      - name: audit-claude
'''
    else:
        config += f'''
claude-api-key:
  - api-key: fixture-provider-key
    base-url: http://127.0.0.1:{upstream.server_port}
    models:
      - name: audit-claude
'''
    if case == "catalog_policy_alias":
        config += "\nclient:\n  codex:\n    enable-apply-patch: true\n"
    process = support.ScenarioProcess(binary, output, case, config, usage_enabled=True)
    result = {"case": case, "passed": False}
    stopped = False
    try:
        manager = process.start(port)
        client = support.HTTPClient(f"http://127.0.0.1:{port}", support.API_KEY_A, process.transcript)
        if case == "catalog_policy_alias":
            verify_catalog_alias(manager, client, root)
            result.update(passed=True)
            return result
        streaming = "_stream_" in case
        native = case == "native_json_success"
        request = {"model": "audit-claude", "stream": streaming}
        if native:
            request.update(max_tokens=16, messages=[{"role": "user", "content": "fixture"}])
        else:
            request.update(input="fixture", tools=[{
                "type": "custom", "name": "apply_patch",
                "format": {"type": "grammar", "syntax": "lark", "definition": "start: patch"},
            }])
        status, body = client.request("POST", "/v1/messages" if native else "/v1/responses", request, timeout=20)
        (root / "client-response.json").write_text(json.dumps({"status": status, "body": body}, indent=2))
        failed = "invalid" in case
        if streaming:
            support.require(status == 200 and isinstance(body, str), f"missing SSE response: {status}, {body}")
            events = [json.loads(line[6:]) for line in body.splitlines()
                      if line.startswith("data: ") and line[6:] != "[DONE]"]
            completed = [event for event in events if event.get("type") == "response.completed"]
            # The HTTP handler maps a translated response.failed to the public
            # error event for clients without the Codex user agent.
            failures = [event for event in events if event.get("type") in ("response.failed", "error")]
            support.require(len(completed) == (0 if failed else 1), f"wrong completed events: {events}")
            support.require(len(failures) == (1 if failed else 0), f"wrong failed events: {events}")
            if not failed:
                support.require(completed[0]["response"]["output"][0]["input"] == PATCH, "patch text changed")
        elif failed:
            support.require(status == 502, f"invalid tool arguments succeeded: {status}, {body}")
        else:
            support.require(status == 200, f"valid response failed: {status}, {body}")
            if native:
                support.require(body["content"][0]["text"] == "ok", "native response changed")
            else:
                support.require(body["output"][0]["type"] == "custom_tool_call", "custom tool declaration lost")
                support.require(body["output"][0]["input"] == PATCH, "patch text changed")
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
        support.require(rows, "usage event did not persist before shutdown")
        # Wait for the async usage publisher before stopping. Query again after
        # the process exits so a late duplicate cannot escape the assertion.
        process.stop()
        stopped = True
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            rows = [dict(row) for row in connection.execute(
                "SELECT request_id,model,response_model,input_tokens,output_tokens,total_tokens,failed "
                "FROM usage_events ORDER BY id"
            )]
        (root / "usage-rows.json").write_text(json.dumps(rows, indent=2))
        support.require(len(rows) == 1, f"expected one persisted event: {rows}")
        row = rows[0]
        support.require(row["response_model"] == "served-model", f"response model lost: {row}")
        support.require(bool(row["failed"]) == failed, f"wrong terminal outcome: {row}")
        support.require((row["input_tokens"], row["output_tokens"], row["total_tokens"]) == (10, 2, 12),
                        f"observed tokens lost: {row}")
        support.require(len(upstream_requests) == 1, f"unexpected retries: {upstream_requests}")
        sent = upstream_requests[0]["body"]
        expected_stream = streaming if case.startswith("openai_") else not native
        support.require(sent.get("stream", False) == expected_stream, f"wrong upstream transport: {sent}")
        if not native:
            tool = sent["tools"][0]
            support.require(tool.get("name", tool.get("function", {}).get("name")) == "apply_patch", f"tool mapping lost: {sent}")
        result.update(passed=True, row=row)
    except Exception:
        result["error"] = traceback.format_exc()
    finally:
        if not stopped:
            process.stop()
        upstream.shutdown()
        upstream.server_close()
        worker.join(timeout=5)
        (root / "upstream-requests.json").write_text(json.dumps(upstream_requests, indent=2))
        (root / "upstream-response.txt").write_bytes(wire)
        result["artifacts"] = process.artifacts()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--scenario", choices=CASES)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    cases = [args.scenario] if args.scenario else CASES
    results = [run_case(args.binary.resolve(), args.output.resolve(), case) for case in cases]
    receipt = {"binarySha256": support.sha256_file(args.binary), "passed": all(r["passed"] for r in results), "results": results}
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"passed": receipt["passed"], "receipt": str(args.output / "receipt.json")}))
    raise SystemExit(0 if receipt["passed"] else 1)


if __name__ == "__main__":
    main()
