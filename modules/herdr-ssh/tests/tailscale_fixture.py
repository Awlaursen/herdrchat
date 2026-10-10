"""Loopback-only SSH fixture: none auth, banner, delayed approval and commands.

No tailnet credentials or real remote shell. Requires paramiko, installed only
in the native CI job. A delay longer than Citadel's ten seconds catches the
original check-mode failure.
"""
import logging
import socket
import sys
import threading
import time
import paramiko

logging.disable(logging.CRITICAL)
key = paramiko.RSAKey.generate(2048)

class Server(paramiko.ServerInterface):
    def get_banner(self):
        return ("Approve at https://login.tailscale.com/a/test-fixture\n", "en")

    def check_auth_none(self, username):
        if username == "slow":
            time.sleep(12)
        if username == "never":
            time.sleep(30)
        return paramiko.AUTH_FAILED if username == "denied" else paramiko.AUTH_SUCCESSFUL

    def get_allowed_auths(self, username):
        return "none"

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        if command == b"refused":
            return False
        def run():
            try:
                # Send the command reply before output, as a real SSH server does.
                time.sleep(0.05)
                if command == b"silent":
                    while not channel.closed:
                        time.sleep(0.05)
                    return
                if command == b"lost":
                    channel.close()
                    return
                channel.sendall(b"first\nsec")
                channel.sendall(b"ond\n")
                channel.sendall_stderr(b"detail")
                channel.send_exit_status(7 if command == b"fail" else 0)
                channel.close()
            except (OSError, EOFError):
                pass
        threading.Thread(target=run, daemon=True).start()
        return True

def serve(sock):
    transport = paramiko.Transport(sock)
    transport.add_server_key(key)
    try:
        transport.start_server(server=Server())
        channels = []
        while transport.is_active():
            channel = transport.accept(1)
            if channel is not None:
                channels.append(channel)
    except (OSError, EOFError, paramiko.SSHException):
        pass
    finally:
        transport.close()

listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", int(sys.argv[1])))
listener.listen()
print("ready", flush=True)
while True:
    sock, _ = listener.accept()
    threading.Thread(target=serve, args=(sock,), daemon=True).start()
