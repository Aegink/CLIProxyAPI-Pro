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
    routes = ["/v0/management/quota/fetch", "/v8/management/credentials/quota/fetch"]
    for iteration, route in enumerate(routes, 1):
        code, body = request(route, {"auth_index": index})
        assert code == 200, (code, body)
        assert body["snapshot"]["plan"]["id"] == f"tier-{iteration}", body
        assert "auth_update" not in body
        _, state = request("/fixture/state")
        assert state["auth"]["token"] == f"updated-{iteration}", state
        assert len(state["entries"]) == 1, state

    for route in routes:
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

    for selector in (
        {"provider": "fixture-plugin"},
        {"plugin_id": "fixture-plugin", "provider": "selected"},
    ):
        code, body = request(routes[1], dict(auth_index=index, **selector))
        assert code == 200, (code, body)

    before = request("/fixture/state")[1]
    with concurrent.futures.ThreadPoolExecutor() as pool:
        pending = pool.submit(request, routes[1], {
            "auth_index": index, "plugin_id": "fixture-plugin", "provider": "delay",
        })
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

    def request(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}" + path, data=data,
            headers={"Authorization": "Bearer quota-fixture-key", "Content-Type": "application/json"},
        )
        try:
            with opener.open(req, timeout=15) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
        decoded = json.loads(raw)
        receipt["requests"].append({"path": path, "status": status, "body": decoded})
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
