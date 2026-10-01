#!/usr/bin/env python3
"""Capture a PNG of the live QuickKey panel via its devtools port."""
import json, socket, base64, os, struct, sys, urllib.request

def send(expr_method, params, out):
    t = json.load(urllib.request.urlopen("http://localhost:8088/json", timeout=5))[0]
    path = t["webSocketDebuggerUrl"].split("localhost:8088", 1)[1]
    s = socket.create_connection(("localhost", 8088), timeout=25)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall(("GET %s HTTP/1.1\r\nHost: localhost:8088\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, key)).encode())
    buf = b""
    while b"\r\n\r\n" not in buf: buf += s.recv(4096)

    msg = json.dumps({"id": 1, "method": expr_method, "params": params}).encode()
    mask = os.urandom(4); n = len(msg); hdr = b"\x81"
    if n < 126: hdr += bytes([0x80 | n])
    elif n < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
    else: hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(msg)))

    chunks = b""
    while True:
        h = s.recv(2)
        if len(h) < 2: break
        fin = h[0] & 0x80
        ln = h[1] & 0x7F
        if ln == 126: ln = struct.unpack(">H", s.recv(2))[0]
        elif ln == 127: ln = struct.unpack(">Q", s.recv(8))[0]
        data = b""
        while len(data) < ln: data += s.recv(ln - len(data))
        chunks += data
        if not fin: continue
        try: r = json.loads(chunks)
        except Exception: chunks = b""; continue
        chunks = b""
        if r.get("id") == 1:
            s.close()
            img = r.get("result", {}).get("data")
            if not img: return "no image: " + json.dumps(r)[:200]
            open(out, "wb").write(base64.b64decode(img))
            return "wrote " + out + " (%d bytes)" % os.path.getsize(out)
    s.close(); return "no reply"

print(send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True}, sys.argv[1]))
