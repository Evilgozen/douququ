#!/usr/bin/env python3
"""B站一键投稿：小文件直传（我们的成片只有几 MB）+ 提交稿件。
用法：
  python3 scripts/publish_bili.py exports/ep001-xxx.mp4 \
    --title "【电子斗蛐蛐】托尼 VS 拳王" --desc "简介…" \
    --tags "电子斗蛐蛐,斗蛐蛐,搞笑" --tid 138 \
    --cover exports/cover-ep001.jpg [--dtime "2026-09-14 12:00"] [--cookie cookies.json]
凭据：先跑 python3 scripts/bili_login.py 生成 cookies.json
"""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.parse

import requests

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"


def load_cookies(path):
    with open(path, encoding="utf8") as f:
        raw = json.load(f)
    if isinstance(raw, list):  # 浏览器导出的数组格式
        return {c["name"]: c["value"] for c in raw if "name" in c}
    return raw


def session_with(cookies):
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": "https://member.bilibili.com/"})
    for k, v in cookies.items():
        s.cookies.set(k, v, domain=".bilibili.com")
    # 领设备指纹：member 域名部分接口对无 buvid 的请求 403
    try:
        spi = s.get("https://api.bilibili.com/x/frontend/finger/spi", timeout=15).json()
        if spi.get("code") == 0:
            s.cookies.set("buvid3", spi["data"]["b_3"], domain=".bilibili.com")
            s.cookies.set("buvid4", spi["data"]["b_4"], domain=".bilibili.com")
    except Exception:
        pass
    return s


def upload_cover(s, cover_path, csrf):
    """封面接口要 base64 data URI 表单，且需裁成 16:10（与 biliup 一致）"""
    import base64
    from io import BytesIO
    from PIL import Image
    with Image.open(cover_path) as im:
        x, y = im.size
        if x / y > 1.6:
            delta = x - y * 1.6
            region = im.crop((delta / 2, 0, x - delta / 2, y))
        else:
            delta = y - x * 10 / 16
            region = im.crop((0, delta / 2, x, y - delta / 2))
        buf = BytesIO()
        region.save(buf, format="JPEG", quality=90)
    r = s.post("https://member.bilibili.com/x/vu/web/cover/up",
               data={"cover": b"data:image/jpeg;base64," + base64.b64encode(buf.getvalue()), "csrf": csrf},
               timeout=30)
    j = r.json()
    if j.get("code") != 0 or not j.get("data"):
        raise SystemExit(f"封面上传失败：{j}")
    return j["data"]["url"]


def preupload(s, video_path):
    size = os.path.getsize(video_path)
    params = {
        "r": "upos",
        "profile": "ugcupos/bup",
        "ssl": 0,
        "version": "2.8.12",
        "build": 2081200,
        "name": os.path.basename(video_path),
        "size": size,
        "upcdn": "bda2",
        "probe_version": "20221109",
    }
    r = s.get("https://member.bilibili.com/preupload", params=params, timeout=30)
    try:
        j = r.json()
    except ValueError:
        raise SystemExit(f"预上传失败 HTTP {r.status_code}（非 JSON 响应，可能被风控）")
    if "upos_uri" not in j:
        raise SystemExit(f"预上传失败：{j}")
    return j, size


def upos_put(s, pre, video_path):
    """upos 三步协议：init → 分片 PUT → 合并（与 biliup 一致）"""
    import math
    upos_path = pre["upos_uri"].replace("upos://", "")
    endpoint = pre["endpoint"]
    if endpoint.startswith("//"):
        endpoint = "https:" + endpoint
    elif not endpoint.startswith("http"):
        endpoint = "https://" + endpoint
    url = f"{endpoint}/{upos_path}"
    auth = {"X-Upos-Auth": pre.get("auth", "")}
    total = os.path.getsize(video_path)
    chunk_size = pre.get("chunk_size", 4 * 1024 * 1024)

    r = s.post(f"{url}?uploads&output=json", headers=auth, timeout=30).json()
    upload_id = r["upload_id"]

    chunks = math.ceil(total / chunk_size)
    parts = []
    with open(video_path, "rb") as f:
        for i in range(chunks):
            chunk = f.read(chunk_size)
            params = {
                "uploadId": upload_id, "chunks": chunks, "total": total, "chunk": i,
                "size": chunk_size, "partNumber": i + 1, "start": i * chunk_size,
                "end": i * chunk_size + len(chunk),
            }
            r = s.put(url, params=params, data=chunk, headers=auth, timeout=600)
            if r.status_code not in (200, 201):
                raise SystemExit(f"分片 {i+1}/{chunks} 上传失败 HTTP {r.status_code}：{r.text[:150]}")
            parts.append({"partNumber": i + 1, "eTag": "etag"})
            print(f"\r分片 {i+1}/{chunks}…", end="")

    p = {
        "name": os.path.basename(video_path),
        "uploadId": upload_id,
        "biz_id": pre.get("biz_id"),
        "output": "json",
        "profile": "ugcupos/bup",
    }
    r = s.post(url, params=p, json={"parts": parts}, headers=auth, timeout=30).json()
    if r.get("OK") != 1:
        raise SystemExit(f"合并分片失败：{r}")
    print()
    # biliup 提交时用的 filename 不带扩展名
    return os.path.splitext(os.path.basename(upos_path))[0]


def submit(s, pre, bili_filename, video_path, args, cover_url, csrf):
    title = os.path.splitext(os.path.basename(video_path))[0] if not args.title else args.title
    now = int(time.time())
    post = {
        "copyright": 1,
        "source": "",
        "tid": args.tid,
        "cover": cover_url,
        "title": title,
        "desc_format_id": 0,
        "desc": args.desc or title,
        "dynamic": "",
        "tag": args.tags,
        "videos": [{"filename": bili_filename, "title": "正片", "desc": ""}],
        "no_reprint": 1,
        "open_elec": 0,
        "dtime": None,
        "act_reserve_create": 0,
        "csrf": csrf,
    }
    if args.dtime:
        dt = int(datetime.datetime.strptime(args.dtime, "%Y-%m-%d %H:%M").timestamp())
        if dt - now <= 14400:
            raise SystemExit("定时发布时间必须晚于当前时间 4 小时以上")
        post["dtime"] = dt
    if args.copyright:
        post["copyright"] = args.copyright
    r = s.post(f"https://member.bilibili.com/x/vu/web/add/v3?csrf={csrf}", json=post, timeout=30)
    j = r.json()
    if j.get("code") != 0:
        raise SystemExit(f"投稿失败：{j}")
    aid = j["data"]["aid"]
    bvid = j["data"].get("bvid", "")
    print(f"\n投稿成功：av{aid} https://www.bilibili.com/video/{bvid}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--title", default="")
    ap.add_argument("--desc", default="")
    ap.add_argument("--tags", default="电子斗蛐蛐,斗蛐蛐,搞笑")
    ap.add_argument("--tid", type=int, default=138, help="分区，默认 138（生活-搞笑）")
    ap.add_argument("--cover", default="")
    ap.add_argument("--dtime", default=None, help="定时发布 YYYY-MM-DD HH:MM（需晚于现在 4 小时以上）")
    ap.add_argument("--copyright", type=int, default=1, help="1=自制 2=转载，默认自制")
    ap.add_argument("--cookie", default="cookies.json")
    args = ap.parse_args()

    if not os.path.isfile(args.video):
        raise SystemExit(f"视频不存在：{args.video}")
    if not os.path.isfile(args.cookie):
        raise SystemExit(f"凭据不存在：{args.cookie}（先跑 python3 scripts/bili_login.py）")
    if not args.cover:
        raise SystemExit("B站投稿必须带封面：先 npm run cover -- <video> 生成，再 --cover 传入")

    cookies = load_cookies(args.cookie)
    csrf = cookies.get("bili_jct")
    if not csrf:
        raise SystemExit("cookies 里没有 bili_jct，凭据可能不完整，重新扫码登录")
    s = session_with(cookies)

    me = s.get("https://api.bilibili.com/x/space/myinfo", timeout=15).json()
    if me.get("code") != 0:
        raise SystemExit(f"登录态校验失败：{me.get('code')} {me.get('message')}（重新扫码登录）")
    print(f"登录态 OK：{me['data'].get('name')}")

    pre, size = preupload(s, args.video)
    print(f"预上传 OK（biz_id={pre.get('biz_id')}，{size/1024/1024:.1f} MB），开始上传…")
    bili_filename = upos_put(s, pre, args.video)
    print("视频上传完成")
    cover_url = upload_cover(s, args.cover, csrf) if args.cover else ""
    print(f"封面上传完成：{cover_url}")
    submit(s, pre, bili_filename, args.video, args, cover_url, csrf)


if __name__ == "__main__":
    main()
