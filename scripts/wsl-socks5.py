import socket, threading, select, struct
HOST, PORT = "127.0.0.1", 1080

def handle(conn):
    try:
        data = conn.recv(256)
        if not data or data[0] != 5:
            return
        conn.sendall(b"\x05\x00")
        req = conn.recv(4)
        if len(req) < 4 or req[1] != 1:
            return
        atyp = req[3]
        if atyp == 1:
            addr = socket.inet_ntoa(conn.recv(4))
            port = struct.unpack("!H", conn.recv(2))[0]
        elif atyp == 3:
            ln = conn.recv(1)[0]
            addr = conn.recv(ln).decode()
            port = struct.unpack("!H", conn.recv(2))[0]
        else:
            return
        try:
            remote = socket.create_connection((addr, port), timeout=25)
        except Exception:
            conn.sendall(b"\x05\x05\x00\x01" + b"\x00" * 6)
            return
        conn.sendall(b"\x05\x00\x00\x01" + socket.inet_aton("0.0.0.0") + struct.pack("!H", 0))
        sockets = [conn, remote]
        while True:
            r, _, _ = select.select(sockets, [], [], 120)
            if not r:
                break
            for s in r:
                other = remote if s is conn else conn
                try:
                    d = s.recv(65536)
                except Exception:
                    d = b""
                if not d:
                    return
                try:
                    other.sendall(d)
                except Exception:
                    return
    finally:
        try:
            conn.close()
        except Exception:
            pass

s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((HOST, PORT))
s.listen(128)
print("listening", PORT, flush=True)
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
