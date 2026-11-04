"""메일로 보낼 수 있는 단독 실행 HTML 생성(claude.ai 없이 브라우저에서 파일로 열기).

  python tools/build_standalone.py            → dist/공공영업대시보드.html (데이터 없음, 열어서 엑셀 선택)
  python tools/build_standalone.py --with-data → dist/공공영업대시보드_기준데이터포함.html (web_artifact/base_data.js 내장)

CSS·JS·라이브러리를 모두 한 파일에 넣으며 외부 서버로 데이터를 보내지 않는다.
dist/ 는 .gitignore 대상(회사 데이터 포함 가능).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
W = ROOT / "web_artifact"
DIST = ROOT / "dist"


def js(path: Path) -> str:
    s = path.read_text(encoding="utf-8")
    return s.replace("</script", "<\\/script")


def build(with_data: bool) -> Path:
    page = (W / "index.html").read_text(encoding="utf-8")
    body = page
    body = re.sub(r'<link rel="stylesheet" href="app\.css">\n?', "", body)
    body = re.sub(r'<script src="[^"]+"></script>\n?', "", body)
    title = re.search(r"<title>.*?</title>", body).group(0)
    body = body.replace(title, "")
    links = "".join(re.findall(r"<link [^>]+>\n?", body))
    body = re.sub(r"<link [^>]+>\n?", "", body)
    scripts = ["<script>window.PSD_STANDALONE = true;</script>"]
    for name in ["vendor/chart.umd.min.js", "vendor/xlsx.full.min.js", "engine.js"]:
        scripts.append(f"<script>\n{js(W / name)}\n</script>")
    if with_data:
        bd = W / "base_data.js"
        if not bd.exists():
            sys.exit("web_artifact/base_data.js 가 없습니다(기준 파일을 먼저 내장하세요).")
        scripts.append(f"<script>\n{js(bd)}\n</script>")
    scripts.append(f"<script>\n{js(W / 'app.js')}\n</script>")
    html = (
        "<!doctype html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"{title}\n{links}<style>\n{(W / 'app.css').read_text(encoding='utf-8')}\n"
        "body{margin:0}[hidden]{display:none!important}\n</style>\n</head>\n<body>\n"
        f"{body}\n" + "\n".join(scripts) + "\n</body>\n</html>\n"
    )
    DIST.mkdir(exist_ok=True)
    out = DIST / ("공공영업대시보드_기준데이터포함.html" if with_data else "공공영업대시보드.html")
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    p = build("--with-data" in sys.argv)
    print(p, f"{p.stat().st_size / 1024 / 1024:.2f}MB")
