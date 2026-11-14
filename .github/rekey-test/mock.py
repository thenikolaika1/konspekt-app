# Заглушка Supabase Auth для проверки скрипта смены ключа (без сети, без настоящих ключей).
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = sys.argv[1]
LOG = sys.argv[2]
UID = "c7b537ae-8fbb-4c9a-a047-26c8ccda1cfe"
MAIL = "id-kn-ek83ff@id.konspekt.invalid"
state = {"pw": None}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj=None):
        b = json.dumps(obj or {}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def rec(self, body):
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"m": self.command, "p": self.path, "apikey": self.headers.get("apikey"), "auth": self.headers.get("Authorization"), "body": body}) + "\n")

    def do_GET(self):
        self.rec(None)
        if MODE == "get401":
            return self.send(401, {"msg": "bad key"})
        if MODE == "wrongemail":
            return self.send(200, {"id": UID, "email": "id-kn-zzzzzz@id.konspekt.invalid"})
        return self.send(200, {"id": UID, "email": MAIL})

    def do_PUT(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        self.rec(body)
        if MODE == "put500":
            return self.send(500, {"msg": "boom"})
        state["pw"] = body.get("password")
        return self.send(200, {"id": UID, "email": MAIL})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        self.rec(body)
        if self.path.startswith("/auth/v1/logout"):
            self.send_response(204)
            self.end_headers()
            return
        if MODE == "login400" or body.get("password") != state["pw"]:
            return self.send(400, {"error": "invalid_grant"})
        return self.send(200, {"access_token": "test-token", "user": {"id": UID, "email": MAIL}})


HTTPServer(("127.0.0.1", 8765), H).serve_forever()
