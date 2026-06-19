#!/usr/bin/env python3
"""Разовая чистка имён товаров В ЯДРЕ (без Б24): срезает мусорный лейбл [&quot]/["]
и раскодирует HTML-сущности (&quot;→" дюймы и т.п.). Запуск на спейре, токен из ~/erpnext/backend.env.

Зачем core-side: полный --items виснет на чтении Б24 (рейт-лимит). Эти имена уже в ядре —
правим напрямую, мгновенно, Б24 не трогаем.
"""
import json, urllib.request, re, os

env = open(os.path.expanduser("~/erpnext/backend.env")).read()
TOKEN = [l.split("=", 1)[1].strip() for l in env.splitlines() if l.startswith("ERPNEXT_TOKEN=")][0]
URL = "http://localhost:8080"


def api(method, path, data=None):
    req = urllib.request.Request(
        URL + path,
        data=(json.dumps(data).encode() if data else None),
        method=method,
        headers={"Authorization": TOKEN, "Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=25).read())


def clean(name):
    s = re.sub(r"\s*\[&quot;?\]", "", name)   # срезать мусорный лейбл [&quot] / [&quot;]
    s = re.sub(r'\s*\["\s*\]', "", s)         # и ["] если затесался
    s = (s.replace("&quot;", '"').replace("&amp;", "&")
          .replace("&lt;", "<").replace("&gt;", ">")
          .replace("&laquo;", "«").replace("&raquo;", "»").replace("&nbsp;", " "))
    return s.strip()


items = api("GET", '/api/resource/Item?fields=["name","item_name"]&filters=[["item_name","like","%quot%"]]&limit_page_length=0')["data"]
fixed = 0
for it in items:
    nm = it["item_name"]
    new = clean(nm)
    if new != nm:
        api("PUT", "/api/resource/Item/" + str(it["name"]), {"item_name": new})
        fixed += 1
        print("  ", nm, "->", new)
print("исправлено", fixed, "из", len(items))
