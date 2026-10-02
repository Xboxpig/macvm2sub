"""JSONL control for a real Codex terminal, using the macOS standard library."""
import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, terminal = pty.fork()
if pid == 0:
    args = json.loads(sys.argv[1])
    os.execvpe(args[0], args, os.environ)

def emit(value):
    sys.stdout.write(json.dumps(value) + '\n')
    sys.stdout.flush()

write_buffer = b''
def write(data):
    global write_buffer
    write_buffer += data

fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
os.set_blocking(terminal, False)
emit({'event': 'pid', 'pid': pid})
decoder = codecs.getincrementaldecoder('utf8')('replace')
control = b''
tail = b''
enter_at = None
awaiting_paste = False
reaped = False
try:
    while True:
        ready, writable, _ = select.select([terminal, sys.stdin.fileno()], [terminal] if write_buffer else [], [], 0.05)
        if terminal in writable:
            try:
                sent = os.write(terminal, write_buffer[:16384])
                write_buffer = write_buffer[sent:]
            except BlockingIOError:
                pass
        if awaiting_paste and not write_buffer:
            awaiting_paste = False
            enter_at = time.monotonic() + 0.35
        if terminal in ready:
            try:
                data = os.read(terminal, 65536)
            except OSError:
                break
            if not data:
                break
            merged = tail + data
            for query, answer in [(b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b]11;?\x1b\\', b'\x1b]11;rgb:1010/1010/1010\x1b\\'), (b'\x1b]10;?\x1b\\', b'\x1b]10;rgb:eeee/eeee/eeee\x1b\\')]:
                if merged.find(query, max(0, len(tail) - len(query) + 1)) >= 0:
                    write(answer)
            tail = merged[-32:]
            emit({'event': 'output', 'text': decoder.decode(data)})
        if sys.stdin.fileno() in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            control += chunk
            if len(control) > 8 * 1024 * 1024:
                raise ValueError('Control input too large')
            while b'\n' in control:
                line, control = control.split(b'\n', 1)
                msg = json.loads(line)
                if msg['event'] == 'stop':
                    raise SystemExit(0)
                if msg['event'] == 'submit':
                    text = msg['text']
                    if any(ord(c) < 32 and c not in '\n\t\r' for c in text):
                        raise ValueError('Terminal control characters are forbidden')
                    write(b'\x1b[200~' + text.encode() + b'\x1b[201~')
                    awaiting_paste = True
        if enter_at is not None and time.monotonic() >= enter_at:
            write(b'\r')
            enter_at = None
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            reaped = True
            emit({'event': 'exit', 'status': status})
            break
finally:
    if not reaped:
        try:
            os.killpg(pid, signal.SIGTERM)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    reaped = True
                    break
                time.sleep(0.05)
            if not reaped:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
    os.close(terminal)
