#!/usr/bin/env python3
"""Run quota HTTP convergence against an already built fixture binary."""

import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import socket
import subprocess
import time
import urllib.error
import urllib.request


def snapshots(state):
    # Loading Previous updates the access timestamp even if the fetch later fails.
    return [
        {key: value for key, value in entry.items() if key != "accessedAt"}
        for entry in state["entries"]
    ]


def verify(request):
    for _ in range(150):
        try:
            _, state = request("/fixture/state")
            break
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    else:
        raise AssertionError("readiness timeout")

    index = state["auth_index"]
    probe = state["probe_index"]
    summary_probe = state["summary_probe_index"]
    legacy = "/v0/management/quota/fetch"
    routes = [legacy, "/v0/management/plugins/fixture-plugin/quota",
              "/v8/management/plugins/fixture-plugin/quota"]
    for suffix, method in (("providers", "GET"), ("fetch", "POST"), ("reset", "POST")):
        code, body = request("/v8/management/credentials/quota/" + suffix,
                             None if method == "GET" else {}, method=method)
        assert code == 404, (code, body)
    summary_failures = []
    for iteration, route in enumerate(routes, 1):
        code, body = request(route, {"auth_index": index})
        assert code == 200, (code, body)
        assert body["snapshot"]["plan"]["id"] == f"tier-{iteration}", body
        assert body["subscription"]["tierId"] == f"tier-{iteration}", body
        assert body["groups"][0]["buckets"][0]["remainingFraction"] == 0.75, body
        expected_summary = [{
            "key": "credits_used", "label": "Credits used",
            "value": iteration * 100, "unit": "credits", "format": "number",
        }]
        if body.get("summary") != expected_summary:
            summary_failures.append({
                "route": route, "kind": "native", "expected": expected_summary,
                "actual": body.get("summary"),
            })
        assert "auth_update" not in body
        _, state = request("/fixture/state")
        assert state["auth"]["token"] == f"updated-{iteration}", state
        assert len(state["entries"]) == 1, state

    for route in [legacy]:
        before = request("/fixture/state")[1]
        code, body = request(route, {"auth_index": probe, "plugin_id": "missing"})
        assert code == 501, (code, body)
        after = request("/fixture/state")[1]
        assert snapshots(before) == snapshots(after)
        assert after["probe"]["token"] == "original"

        code, body = request(route, {
            "auth_index": index, "plugin_id": "fixture-plugin", "provider": "fail",
        })
        assert code == 502, (code, body)
        assert snapshots(request("/fixture/state")[1]) == snapshots(before)

        code, body = request(route, {"auth_index": probe})
        assert code == 200 and len(body["snapshot"]["items"]) == 1, (code, body)
        assert request("/fixture/state")[1]["probe"]["token"] == "original"

    declarative_summary = [{
        "key": "balance", "label": "Balance", "value": 42.5,
        "format": "currency", "currency": "USD",
    }]
    for route in [legacy]:
        code, body = request(route, {"auth_index": summary_probe})
        assert code == 200, (code, body)
        assert body["snapshot"]["items"] == [], body
        if body.get("summary") != declarative_summary:
            summary_failures.append({
                "route": route, "kind": "declarative", "expected": declarative_summary,
                "actual": body.get("summary"),
            })
        assert request("/fixture/state")[1]["summary_probe"]["token"] == "original"

    for selector in (
        {"provider": "fixture-plugin"},
        {"plugin_id": "fixture-plugin", "provider": "selected"},
    ):
        code, body = request(legacy, dict(auth_index=index, **selector))
        assert code == 200, (code, body)

    for route in routes[1:]:
        # URL selection wins over misleading legacy body selectors.
        code, body = request(route, {"auth_index": index, "plugin_id": "missing", "provider": "fail"})
        assert code == 200 and body["plugin_id"] == "fixture-plugin", (code, body)
        code, body = request(route + "?authIndex=" + index)
        assert code == 200 and body["summary"], (code, body)
        assert "auth_update" not in body
        state = request("/fixture/state")[1]
        call = body["snapshot"]["plan"]["id"].removeprefix("tier-")
        assert state["auth"]["token"] == "updated-" + call, state
        saved = next(entry for entry in state["entries"] if entry["authIndex"] == index)
        assert saved["data"] == body["snapshot"], (saved, body)
        before = request("/fixture/state")[1]
        for path, payload, expected in (
            (route.replace("fixture-plugin", "missing"), {"auth_index": probe}, 404),
            (route, {"auth_index": "missing"}, 404),
            (route, {}, 400),
        ):
            code, body = request(path, payload)
            assert code == expected, (code, body)
        request("/fixture/mode", {"mode": 1})
        code, body = request(route, {"auth_index": index})
        assert code == 502, (code, body)
        request("/fixture/mode", {"mode": 0})
        after = request("/fixture/state")[1]
        assert snapshots(before) == snapshots(after)
        assert before["auth"] == after["auth"]

    before = request("/fixture/state")[1]
    request("/fixture/mode", {"mode": 2})
    with concurrent.futures.ThreadPoolExecutor() as pool:
        pending = pool.submit(request, routes[2], {"auth_index": index})
        for _ in range(100):
            if request("/fixture/state")[1]["entered"]:
                break
            time.sleep(0.02)
        else:
            raise AssertionError("delayed provider not entered")
        request("/fixture/unload", {})
        code, body = pending.result()
        assert code == 502, (code, body)
    after = request("/fixture/state")[1]
    assert snapshots(before) == snapshots(after)
    assert before["auth"] == after["auth"]
    assert not summary_failures, summary_failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    binary = pathlib.Path(args.binary).resolve()
    receipt = {
        "binary": str(binary),
        "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "requests": [],
        "status": "running",
    }
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, body=None, method=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}" + path, data=data, method=method,
            headers={"Authorization": "Bearer quota-fixture-key", "Content-Type": "application/json"},
        )
        try:
            with opener.open(req, timeout=15) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
        try:
            decoded = json.loads(raw)
        except json.JSONDecodeError:
            decoded = raw.decode()
        receipt["requests"].append({"method": req.get_method(), "path": path, "status": status, "body": decoded})
        return status, decoded

    with (output / "server.log").open("w") as log:
        process = subprocess.Popen(
            [str(binary), str(output), str(port)], stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            verify(request)
            receipt["status"] = "passed"
        except Exception as error:
            receipt["status"] = "failed"
            receipt["error"] = repr(error)
            raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print(output / "receipt.json")


if __name__ == "__main__":
    main()
