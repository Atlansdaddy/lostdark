"""
Hot reload launcher for wAIver.
Watches all .py files in the waiver package.
When any file changes, kills the game and restarts it.
Usage: python -m waiver.hot_reload [--demo=granular] [--force-cpu]
"""
import os
import sys
import time
import subprocess

WATCH_DIR = os.path.dirname(os.path.abspath(__file__))
POLL_INTERVAL = 1.0  # seconds between file checks


def get_file_mtimes(directory):
    """Get dict of {filepath: mtime} for all .py files."""
    mtimes = {}
    for root, dirs, files in os.walk(directory):
        # Skip __pycache__
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for f in files:
            if f.endswith('.py'):
                path = os.path.join(root, f)
                try:
                    mtimes[path] = os.path.getmtime(path)
                except OSError:
                    pass
    return mtimes


def main():
    # Forward CLI args to the game
    args = sys.argv[1:]
    cmd = [sys.executable, '-m', 'waiver'] + args

    print(f'[Hot Reload] Watching {WATCH_DIR}')
    print(f'[Hot Reload] Command: {" ".join(cmd)}')
    print(f'[Hot Reload] Press Ctrl+C to stop\n')

    while True:
        # Snapshot file times before launching
        before = get_file_mtimes(WATCH_DIR)

        # Launch game
        print(f'[Hot Reload] Starting game...')
        proc = subprocess.Popen(cmd, cwd=os.path.dirname(WATCH_DIR))

        try:
            # Poll for file changes while game runs
            while proc.poll() is None:
                time.sleep(POLL_INTERVAL)
                after = get_file_mtimes(WATCH_DIR)

                # Check for changes
                changed = []
                for path, mtime in after.items():
                    if path not in before or before[path] != mtime:
                        changed.append(os.path.relpath(path, WATCH_DIR))

                if changed:
                    print(f'\n[Hot Reload] Files changed:')
                    for f in changed:
                        print(f'  -> {f}')
                    print(f'[Hot Reload] Restarting...\n')

                    # Kill the game
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                    break

            # If game exited on its own (not from file change), check exit code
            if proc.returncode is not None and not changed:
                print(f'[Hot Reload] Game exited (code {proc.returncode})')
                if proc.returncode == 0:
                    # Clean exit (Escape) — quit entirely
                    print('[Hot Reload] Clean exit. Done.')
                    sys.exit(0)
                else:
                    # Crash — ask before restarting
                    print('[Hot Reload] Crash detected. Press Enter to restart or Ctrl+C to quit.')
                    try:
                        input()
                    except (KeyboardInterrupt, EOFError):
                        sys.exit(1)

        except KeyboardInterrupt:
            print('\n[Hot Reload] Shutting down...')
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
            sys.exit(0)


if __name__ == '__main__':
    main()
