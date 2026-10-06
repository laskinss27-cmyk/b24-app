"""Read the allowed ERP catalog. Python 3, no third-party packages.
Usage: python analytics-read.py credentials.json https://ERP-HOST catalog.json
The credential file contains {"token": "..."}. Never put the token in a URL.
"""
import json
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Do not forward a private Authorization header elsewhere.


def download(credentials, base_url):
    if urlsplit(base_url).scheme != "https" or urlsplit(base_url).query or urlsplit(base_url).fragment:
        raise ValueError("Use the supplied HTTPS base URL without query or fragment")
    token = json.loads(Path(credentials).read_text(encoding="utf-8"))["token"]
    opener = build_opener(NoRedirect())
    products, snapshot, cursor, total = [], None, None, None
    while True:
        params = {"limit": 500}
        if cursor:
            params["cursor"] = cursor
        req = Request(base_url.rstrip("/") + "/api/analytics/v1/catalog?" + urlencode(params),
                      headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
        with opener.open(req, timeout=90) as response:
            page = json.load(response)
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
    except HTTPError as error:
        sys.exit(f"ERP HTTP {error.code}; 401: check key, 410: restart, 429: respect Retry-After, 503: retry later. Existing output retained.")
