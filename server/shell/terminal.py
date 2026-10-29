"""A terminal for the host shell (server/shell/index.mjs).

Node has no pseudo-terminal without a native module, and the repo keeps to plain node and
yarn (docs/process/infra.md). Python's standard library has one, and python3 is part of the
machine like git and ssh. This is the whole of it: run a command on a fresh pty, copy its
output to stdout and stdin to it, and take "rows cols" lines on fd 3 to resize it — the
kernel then signals the program in front (SIGWINCH), so a phone turned sideways redraws.

    python3 terminal.py ROWS COLS command [args...]

Not named pty.py: Python puts the script's own folder first on its path, so a file of that
name imports itself in place of the standard module, and the first terminal died with
"module 'pty' has no attribute 'fork'".
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def main():
    rows, cols = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError as err:
            # A sentence on the screen, not a Python traceback: a container shell on a machine
            # with no podman said only "FileNotFoundError" from three frames deep.
            what = "is not installed on this machine" if isinstance(err, FileNotFoundError) else "could not start: " + err.strerror
            os.write(2, ("%s %s\n" % (argv[0], what)).encode())
            os._exit(127)

    def resize(r, c):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

    resize(rows, cols)
    watch = [fd, 0]
    # The resize channel is there when Outpost runs this; by hand it is not, and a missing fd 3
    # must not end the terminal.
    try:
        os.fstat(3)
        watch.append(3)
    except OSError:
        pass
    pending = b""
    while True:
        try:
            ready, _, _ = select.select(watch, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break  # the program ended: the pty is gone
            if not data:
                break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                # Outpost closed the terminal: hang up, as a dropped ssh line does.
                os.kill(pid, signal.SIGHUP)
                watch.remove(0)
            else:
                os.write(fd, data)
        if 3 in ready:
            data = os.read(3, 1024)
            if not data:
                watch.remove(3)
            else:
                pending += data
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    try:
                        r, c = (int(x) for x in line.split())
                        resize(max(r, 2), max(c, 10))
                    except ValueError:
                        pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)


if __name__ == "__main__":
    main()
