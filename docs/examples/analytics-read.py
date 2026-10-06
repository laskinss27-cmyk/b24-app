"""Read the allowed ERP catalog. Python 3 and system curl, no third-party Python packages.
Usage: python analytics-read.py credentials.json https://ERP-HOST catalog.json
The credential file contains {"token": "..."}. Never put the token in a URL.
"""
import json
import sys
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlencode, urlsplit


def request_page(url, token):
    executable = shutil.which("curl.exe" if os.name == "nt" else "curl")
    if not executable:
        raise RuntimeError("System curl is required")
    # Private header goes through stdin, never command-line arguments or a URL.
    result = subprocess.run(
        [executable, "--config", "-", "--silent", "--show-error", "--max-time", "60",
         "--write-out", "\n%{http_code}", url],
        input='header = "Authorization: Bearer ' + token + '"\n',
        capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"HTTPS transport failed (curl {result.returncode}); existing output retained")
    body, status = result.stdout.rsplit("\n", 1)
    if status != "200":
        raise RuntimeError(f"ERP HTTP {status}; 401: check key, 410: restart, 429: wait, 503: retry later. Existing output retained.")
    return json.loads(body)


def download(credentials, base_url):
    if urlsplit(base_url).scheme != "https" or urlsplit(base_url).query or urlsplit(base_url).fragment:
        raise ValueError("Use the supplied HTTPS base URL without query or fragment")
    token = json.loads(Path(credentials).read_text(encoding="utf-8"))["token"]
    if not isinstance(token, str) or not re.fullmatch(r"erp_ro_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}", token):
        raise ValueError("Invalid credential file")
    products, snapshot, cursor, total = [], None, None, None
    while True:
        params = {"limit": 500}
        if cursor:
            params["cursor"] = cursor
        page = request_page(base_url.rstrip("/") + "/api/analytics/v1/catalog?" + urlencode(params), token)
        if snapshot is not None and page["snapshotId"] != snapshot:
            raise ValueError("Snapshot changed; restart the complete download")
        snapshot, total = page["snapshotId"], page["total"]
        products.extend(page["products"])
        next_cursor = page["nextCursor"]
        if next_cursor == cursor and next_cursor is not None:
            raise ValueError("Repeated cursor")
        cursor = next_cursor
        if cursor is None:
            break
    if len(products) != total or len({p["id"] for p in products}) != total:
        raise ValueError("Incomplete or duplicate product list")
    return {**page, "products": products, "nextCursor": None}


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("Usage: python analytics-read.py credentials.json https://ERP-HOST catalog.json")
    try:
        catalog = download(sys.argv[1], sys.argv[2])
        output = Path(sys.argv[3])
        temporary = output.with_name(output.name + ".partial")
        temporary.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(output)  # Replace the old file only after a complete download.
        print("Downloaded", len(catalog["products"]), "products at", catalog["generatedAt"])
    except (RuntimeError, ValueError, OSError) as error:
        sys.exit(str(error))
