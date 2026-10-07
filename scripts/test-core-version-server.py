#!/usr/bin/env python3
"""Exercise package switching on a disposable, already installed test server.

Run as root, with an operator token in a mode-0600 JSON file containing `token`:
  python3 scripts/test-core-version-server.py --execute --access /root/access.json

This deliberately switches versions, writes a temporary invalid configuration,
occupies the native API port to force rollback, and interrupts a task to exercise
boot recovery. It must never run against a production node. No SSH credentials or
operator secrets are printed. The panel must use the standard local installation.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="Allow disruptive tests on this disposable server")
    parser.add_argument("--access", type=Path, required=True)
    parser.add_argument("--base", default="http://127.0.0.1:8000/apiv2")
    parser.add_argument("--from-version", default="1.14.2")
    parser.add_argument("--to-version", default="1.14.1")
    parser.add_argument("--native-port", type=int, default=9091)
    parser.add_argument("--only", choices=["switch", "validation", "rollback", "interrupted"])
    args = parser.parse_args()
    if not args.execute or os.geteuid() != 0 or args.access.stat().st_mode & 0o077:
        parser.error("Requires --execute, root and a root-private access file")
    token = json.loads(args.access.read_text())["token"]
    root = Path("/var/lib/x-ui/core-version/jobs")
    config = Path("/etc/sing-box/config.json")
    active_states = {"queued", "running", "rolling_back"}

    def api(path, body=None, expected=200):
        request = Request(args.base + path, data=None if body is None else json.dumps(body).encode(),
                          headers={"Token": token, "Content-Type": "application/json"})
        try:
            response = urlopen(request, timeout=55)
        except HTTPError as error:
            response = error
        with response:
            status, payload = response.status, json.load(response)
        assert status == expected, f"{path}: expected {expected}, got {status}: {payload.get('msg')}"
        assert payload["success"] == (status < 400), f"{path}: bad response envelope"
        return payload.get("obj")

    def command(*arguments):
        result = subprocess.run(arguments, capture_output=True, timeout=120)
        assert result.returncode == 0, f"{arguments[0]} {arguments[1:]} failed"
        return result.stdout.decode().strip()

    def pid():
        return command("systemctl", "show", "sing-box.service", "--property=MainPID", "--value")

    def verify(version):
        status = api("/core/versions")
        assert status["supported"], status.get("reason")
        assert status["currentVersion"] == version, status["currentVersion"]
        assert command("dpkg-query", "-W", "-f=${Version}", "sing-box") == version
        command("x-ui-cli", "node", "-check", "-directory", "/etc/x-ui")
        for service in ("x-ui-api", "x-ui-worker", "sing-box", "x-ui-agent"):
            assert command("systemctl", "is-active", service) == "active"
        return status

    def queue(version, duplicate=False):
        checked = api("/core/version/check", {"version": version})
        body = {"checkId": checked["checkId"], "expectedCurrentVersion": checked["currentVersion"],
                "configRevision": checked["configRevision"]}
        job = api("/core/version", body, 202)
        if duplicate:
            assert api("/core/version", body, 202)["id"] == job["id"]
            api("/core/restart", {}, 409)
            panel_upgrade = api("/upgrade/check", {})
            assert not panel_upgrade["canUpgrade"] and panel_upgrade.get("blockedReason")
        return job

    def wait(job):
        deadline = time.monotonic() + 600
        previous = None
        while time.monotonic() < deadline:
            result = api("/core/version/jobs/" + job["id"])
            phase = result["state"], result["phase"]
            if phase != previous:
                print("task", job["id"], *phase, flush=True)
                previous = phase
            if result["state"] not in active_states:
                return result
            time.sleep(0.25)
        raise AssertionError("Task did not finish within ten minutes")

    def persisted(job):
        return json.loads((root / job["id"] / "job.json").read_text())

    def terminal(result, state):
        assert result["state"] == state and not result["needsRecovery"], result
        assert result.get("finishedAt"), result

    initial = verify(args.from_version)
    assert any(release["version"] == args.to_version for release in initial["versions"])
    api("/core/version/check", {"version": "1.13.0"}, 400)
    api("/core/version/check", {"version": "1.15.0-alpha.1"}, 400)
    api("/core/version/check", {"version": args.to_version, "url": "https://example.com/evil.deb"}, 400)
    api("/core/version", {"checkId": "../other"}, 400)

    if args.only in (None, "switch"):
        before = pid()
        terminal(wait(queue(args.to_version, duplicate=True)), "succeeded")
        verify(args.to_version)
        assert pid() != before
        terminal(wait(queue(args.from_version)), "succeeded")
        verify(args.from_version)
        print("PASS downgrade, upgrade, idempotent submission and maintenance exclusion", flush=True)

    if args.only in (None, "validation"):
        before, original = pid(), config.read_bytes()
        try:
            config.write_bytes(b'{"invalid-test":\n')
            result = wait(queue(args.to_version))
            terminal(result, "failed")
            assert not persisted(result)["stopRequested"]
            assert pid() == before
        finally:
            config.write_bytes(original)
        verify(args.from_version)
        print("PASS incompatible configuration leaves the running core unchanged", flush=True)

    if args.only in (None, "rollback", "interrupted"):
        marker = Path("/var/lib/sing-box/x-ui-version-integration.marker")
        if marker.exists():
            raise AssertionError("Refusing to overwrite an existing integration marker")
        marker.write_bytes(b"original state\n")
        original_config = hashlib.sha256(config.read_bytes()).hexdigest()
        job = queue(args.to_version)
        injected, finish, failures = threading.Event(), threading.Event(), []

        def fault():
            occupied = None
            try:
                deadline = time.monotonic() + 500
                while time.monotonic() < deadline and not finish.is_set():
                    record = persisted(job)
                    current = record["job"]
                    if current["state"] == "rolling_back":
                        return
                    if current["state"] not in active_states:
                        return
                    if record["stopRequested"] and occupied is None:
                        candidate = socket.socket()
                        candidate.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        try:
                            candidate.bind(("127.0.0.1", args.native_port))
                            candidate.listen()
                            occupied = candidate
                            injected.set()
                        except OSError:
                            candidate.close()
                    if occupied is not None and record["installRequested"]:
                        marker.write_bytes(b"changed state to be rolled back\n")
                    time.sleep(0.015)
            except Exception as error:
                failures.append(str(error))
            finally:
                if occupied:
                    occupied.close()

        watcher = threading.Thread(target=fault, daemon=True)
        watcher.start()
        try:
            if args.only == "interrupted":
                deadline = time.monotonic() + 500
                while time.monotonic() < deadline:
                    record = persisted(job)
                    if record["job"]["phase"] == "verifying":
                        break
                    assert record["job"]["state"] in active_states, record["job"]
                    time.sleep(0.03)
                else:
                    raise AssertionError("Did not reach verification before interruption")
                command("systemctl", "stop", "x-ui-core-version-" + job["id"] + ".service")
                finish.set()
                watcher.join(3)
                command("systemctl", "stop", "sing-box.service")
                # Exercise the unit's before-sing-box restoration and its separately
                # scheduled verification, without rebooting the disposable server.
                command("systemctl", "start", "x-ui-core-version-recovery.service")
            result = wait(job)
            terminal(result, "rolled_back")
            assert injected.is_set() and not failures, failures
            assert marker.read_bytes() == b"original state\n"
            assert hashlib.sha256(config.read_bytes()).hexdigest() == original_config
            assert (root / job["id"] / "backup/snapshot.json").stat().st_mode & 0o077 == 0
            verify(args.from_version)
        finally:
            finish.set()
            watcher.join(3)
            marker.unlink(missing_ok=True)
        print("PASS interrupted boot recovery" if args.only == "interrupted" else
              "PASS forced readiness failure restores exact package, configuration and state", flush=True)

    verify(args.from_version)
    print("All selected live sing-box version tests passed.", flush=True)


if __name__ == "__main__":
    main()
