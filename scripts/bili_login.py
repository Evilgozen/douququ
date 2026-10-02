#!/usr/bin/env python3
"""B站扫码登录：生成二维码 → 手机B站App扫码确认 → cookies.json 落盘。
用法：python3 scripts/bili_login.py [--out cookies.json]
"""
import argparse
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request

APPKEY = "4409e2ce8ffd12b8"
APPSEC = "59b43e04ad6965f34319062b478f83dd"
AUTH_URL = "https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code"
POLL_URL = "https://passport.bilibili.com/x/passport-tv-login/qrcode/poll"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"


def signed(params):
    params = dict(params)
    params["ts"] = int(time.time())
    qs = urllib.parse.urlencode(params)
    params["sign"] = hashlib.md5(f"{qs}{APPSEC}".encode()).hexdigest()
    return params


def post(url, params):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode(),
                                 headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def show_qr(url):
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except ImportError:
        print(f"（pip install qrcode 可显示二维码）请把下面的链接转成二维码后用B站App扫码：\n{url}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="cookies.json")
    args = ap.parse_args()

    r = post(AUTH_URL, signed({"appkey": APPKEY, "local_id": "0"}))
    if r.get("code") != 0:
        raise SystemExit(f"生成二维码失败：{r}")
    auth_code = r["data"]["auth_code"]
    show_qr(r["data"]["url"])
    print("等待扫码确认（最长 180 秒）…")

    params = signed({"appkey": APPKEY, "auth_code": auth_code, "local_id": "0"})
    for _ in range(180):
        time.sleep(1)
        r = post(POLL_URL, params)
        code = r.get("code")
        if code == 86038:
            raise SystemExit("二维码已过期，重跑即可")
        if code == 86090:
            print("已扫码，等待手机上点确认…")
            continue
        if code == 86039:
            continue
        if code == 0:
            cookies = {c["name"]: c["value"] for c in r["data"]["cookie_info"]["cookies"]}
            with open(args.out, "w", encoding="utf8") as f:
                json.dump(cookies, f, ensure_ascii=False, indent=2)
            mid = r["data"].get("mid", "?")
            print(f"\n登录成功（mid={mid}），凭据已写入 {args.out}")
            return
    raise SystemExit("超时，重跑即可")


if __name__ == "__main__":
    main()
