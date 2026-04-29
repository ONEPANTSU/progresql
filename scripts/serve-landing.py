#!/usr/bin/env python3
from __future__ import annotations

import argparse
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


REPO_ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = REPO_ROOT / "static"
LANDING_DIR = STATIC_DIR / "landing"
LEGAL_DIR = STATIC_DIR / "legal"
PAYMENT_DIR = STATIC_DIR / "payment"


def _guess_type(path: Path) -> str:
    t, _ = mimetypes.guess_type(str(path))
    return t or "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 (keep stdlib signature)
        parsed = urlparse(self.path)
        req_path = unquote(parsed.path)

        file_path = self._map_path(req_path)
        if file_path is None or not file_path.is_file():
            self.send_error(404)
            return

        try:
            st = file_path.stat()
            self.send_response(200)
            self.send_header("Content-Type", _guess_type(file_path))
            self.send_header("Content-Length", str(st.st_size))
            # Keep dev iteration snappy; avoid caching surprises.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with file_path.open("rb") as f:
                self.wfile.write(f.read())
        except BrokenPipeError:
            return

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        req_path = unquote(parsed.path)

        file_path = self._map_path(req_path)
        if file_path is None or not file_path.is_file():
            self.send_error(404)
            return

        st = file_path.stat()
        self.send_response(200)
        self.send_header("Content-Type", _guess_type(file_path))
        self.send_header("Content-Length", str(st.st_size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        # Keep output minimal; useful during local dev.
        return

    @staticmethod
    def _map_path(req_path: str) -> Path | None:
        """
        Map production-like URLs to repo files.

        Prod nginx serves "/" from /var/www/progresql/landing/,
        but also serves "/screenshot.png" from web root and "/progresql.mp4"
        from the landing directory.
        """
        if req_path in ("", "/"):
            return LANDING_DIR / "index.html"

        # Special-case assets referenced via absolute root in the landing HTML.
        if req_path == "/screenshot.png":
            return LANDING_DIR / "screenshot.png"
        if req_path == "/progresql.mp4":
            return STATIC_DIR / "progresql.mp4"
        if req_path in ("/favicon.png", "/icon.png"):
            return LANDING_DIR / req_path.lstrip("/")

        # Keep compatibility with og:image="/landing/og-image.png"
        if req_path.startswith("/landing/"):
            sub = req_path.removeprefix("/landing/").lstrip("/")
            return LANDING_DIR / sub

        if req_path.startswith("/legal/"):
            sub = req_path.removeprefix("/legal/").lstrip("/")
            return LEGAL_DIR / sub

        if req_path.startswith("/payment/"):
            sub = req_path.removeprefix("/payment/").lstrip("/")
            return PAYMENT_DIR / sub

        # Fall back to landing dir first (since prod "/" is the landing root).
        candidate = LANDING_DIR / req_path.lstrip("/")
        if candidate.is_file():
            return candidate

        # Then fall back to static root.
        candidate = STATIC_DIR / req_path.lstrip("/")
        if candidate.is_file():
            return candidate

        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("port", nargs="?", type=int, default=8787)
    args = parser.parse_args()

    # Ensure mp4 is served with correct MIME.
    mimetypes.add_type("video/mp4", ".mp4")

    os.chdir(str(REPO_ROOT))
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Landing dev server: http://127.0.0.1:{args.port}/")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

