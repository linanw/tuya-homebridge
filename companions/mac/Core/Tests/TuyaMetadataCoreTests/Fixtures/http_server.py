#!/usr/bin/env python3
"""Loopback-only XCTest fixture. It never logs bodies or authorization values."""

import sys
print("fixture startup: importing standard library", file=sys.stderr, flush=True)
import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from urllib.parse import urlsplit


TOKEN = "SYNTHETIC-XCTEST-SESSION-TOKEN-0123456789"
print("fixture startup: reading canonical snapshot", file=sys.stderr, flush=True)
with open(sys.argv[2], encoding="utf-8") as file:
    snapshot = json.load(file)
snapshot.update(sourceKind="tuya-project-custom", roomsAvailable=False, homes=[], rooms=[])
snapshot["capabilities"].update(renameDevice=True, moveDevice=False, renameRoom=False)
for device in snapshot["devices"]:
    device.update(homeId=None, roomId=None, roomStatus="unsupported")
counts = {
    "posts": 0,
    "receiptGets": 0,
    "redirectTargets": 0,
    "authorizationValid": True,
    "jsonAcceptValid": True,
    "jsonContentTypeValid": True,
    "lastCommandId": None,
    "lastOperationType": None,
    "lastExpectedRevision": None,
}
commands = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def send_json(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        valid = self.headers.get("Authorization") == "Bearer " + TOKEN
        counts["authorizationValid"] &= valid
        counts["jsonAcceptValid"] &= self.headers.get("Accept") == "application/json"
        if not valid:
            self.send_json(401, {"code": "unauthorized"})
        return valid

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/fixture/state":
            self.send_json(200, counts)
            return
        if path == "/redirect-target":
            counts["redirectTargets"] += 1
            self.send_json(200, snapshot)
            return
        if not self.authorized():
            return
        if path.startswith("/redirect301/") or path.startswith("/redirect302/"):
            self.send_response(301 if path.startswith("/redirect301/") else 302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/redirect-target")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            return
        if path.startswith("/oversize/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(4 * 1024 * 1024 + 1))
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(b" " * (4 * 1024 * 1024 + 1))
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if path.startswith("/chunked/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            chunk = b" " * 16384
            try:
                for _ in range(257):
                    self.wfile.write(f"{len(chunk):x}\r\n".encode("ascii") + chunk + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if path == "/ok/v1/capabilities":
            self.send_json(200, {key: value for key, value in snapshot.items()
                                 if key not in ("homes", "rooms", "devices")})
        elif path == "/ok/v1/metadata":
            self.send_json(200, snapshot)
        elif path.startswith("/ok/v1/metadata/commands/"):
            counts["receiptGets"] += 1
            command = commands.get(path.rsplit("/", 1)[1])
            if not command:
                self.send_json(404, {"code": "not_found"})
                return
            if not command["confirmed"]:
                snapshot["devices"][0]["name"] = command["operation"]["name"]
                snapshot["revision"] = str(int(snapshot["revision"]) + 1)
                command["confirmed"] = True
            self.send_json(200, {"schemaVersion": 1, "commandId": command["commandId"],
                                 "status": "confirmed", "code": None, "snapshot": snapshot})
        else:
            self.send_json(404, {"code": "not_found"})

    def do_POST(self):
        if not self.authorized():
            return
        counts["posts"] += 1
        counts["jsonContentTypeValid"] &= self.headers.get("Content-Type") == "application/json"
        length = int(self.headers.get("Content-Length", "0"))
        if self.path != "/ok/v1/metadata/commands" or length > 16384:
            self.send_json(400, {"code": "invalid_request"})
            return
        try:
            command = json.loads(self.rfile.read(length))
            operation = command["operation"]
            if command["schemaVersion"] != 1 or operation["type"] != "device.rename":
                raise ValueError()
            if operation["targetId"] != snapshot["devices"][0]["id"]:
                raise ValueError()
            if command["expected"] != {key: snapshot[key] for key in ("serverId", "sourceEpoch", "revision")}:
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            self.send_json(400, {"code": "invalid_request"})
            return
        counts.update(lastCommandId=command["commandId"], lastOperationType=operation["type"],
                      lastExpectedRevision=command["expected"]["revision"])
        saved = copy.deepcopy(command)
        saved["confirmed"] = False
        commands[command["commandId"]] = saved
        self.send_json(202, {"schemaVersion": 1, "commandId": command["commandId"],
                            "status": "queued", "code": None, "snapshot": None})


class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer normally performs reverse DNS during bind. This numeric
        # loopback fixture must not depend on the hosted runner's DNS resolver.
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


print("fixture startup: binding numeric loopback", file=sys.stderr, flush=True)
server = LoopbackServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
Path(sys.argv[1]).write_text(json.dumps({"port": server.server_port}), encoding="utf-8")
print("fixture startup: ready", file=sys.stderr, flush=True)
server.serve_forever(poll_interval=0.1)
