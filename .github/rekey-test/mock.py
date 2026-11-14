# Заглушка Supabase Auth для проверки скрипта смены ключа (без сети, без настоящих ключей).
# Режим = "<ответ на PUT>+<ответ на вход>", например put200+login200, putdrop+login500.
import json, sys
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

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def rec(self, body):
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"m": self.command, "p": self.path, "apikey": self.headers.get("apikey"), "auth": self.headers.get("Authorization"), "body": body, "pw_after": state["pw"]}) + "\n")

    def do_GET(self):
        self.rec(None)
        if "get401" in MODE:
            return self.send(401, {"msg": "bad key"})
        if "wrongemail" in MODE:
            return self.send(200, {"id": UID, "email": "id-kn-zzzzzz@id.konspekt.invalid"})
        return self.send(200, {"id": UID, "email": MAIL})

    def do_PUT(self):
        b = self.body()
        if "put422" in MODE:
            self.rec(b)
            return self.send(422, {"msg": "weak password"})
        if "put500" in MODE:
            self.rec(b)
            return self.send(500, {"msg": "boom"})
        state["pw"] = b.get("password")
        self.rec(b)
        if "putdrop" in MODE:  # пароль изменён, но ответ потерян
            self.close_connection = True
            return
        return self.send(200, {"id": UID, "email": MAIL})

    def do_POST(self):
        b = self.body()
        self.rec(b)
        if self.path.startswith("/auth/v1/logout"):
            self.send_response(204)
            self.end_headers()
            return
        if "login500" in MODE:
            return self.send(500, {"msg": "boom"})
        if "login400" in MODE or b.get("password") != state["pw"]:
            return self.send(400, {"error": "invalid_grant"})
        return self.send(200, {"access_token": "test-token", "user": {"id": UID, "email": MAIL}})


HTTPServer(("127.0.0.1", 8765), H).serve_forever()
