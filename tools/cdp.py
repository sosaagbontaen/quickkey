#!/usr/bin/env python3
"""Minimal Chrome DevTools Protocol client — evaluate JS inside the CEP panel."""
import json, socket, base64, os, struct, sys, urllib.request

def targets():
    return json.load(urllib.request.urlopen("http://localhost:8088/json", timeout=4))

def evaluate(expr):
    t = targets()[0]
    ws = t["webSocketDebuggerUrl"]
    path = ws.split("localhost:8088", 1)[1]
    s = socket.create_connection(("localhost", 8088), timeout=6)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall(("GET %s HTTP/1.1\r\nHost: localhost:8088\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, key)).encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(4096)

    msg = json.dumps({"id": 1, "method": "Runtime.evaluate",
                      "params": {"expression": expr, "returnByValue": True}}).encode()
    mask = os.urandom(4)
    n = len(msg)
    hdr = b"\x81"
    if n < 126:   hdr += bytes([0x80 | n])
    elif n < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:         hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(msg)))

    def frame():
        h = s.recv(2)
        if len(h) < 2: return None
        ln = h[1] & 0x7F
        if ln == 126: ln = struct.unpack(">H", s.recv(2))[0]
        elif ln == 127: ln = struct.unpack(">Q", s.recv(8))[0]
        data = b""
        while len(data) < ln: data += s.recv(ln - len(data))
        return data

    for _ in range(20):
        d = frame()
        if d is None: break
        try: r = json.loads(d)
        except Exception: continue
        if r.get("id") == 1:
            s.close()
            res = r.get("result", {}).get("result", {})
            if "value" in res: return res["value"]
            return res
    s.close(); return "(no reply)"

if __name__ == "__main__":
    out = evaluate(sys.argv[1])
    print(json.dumps(out, indent=2) if not isinstance(out, str) else out)
