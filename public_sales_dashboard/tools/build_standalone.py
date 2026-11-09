"""메일로 보낼 수 있는 단독 실행 HTML 생성(claude.ai 없이 브라우저에서 파일로 열기).

  python tools/build_standalone.py            → dist/공공영업대시보드.html (데이터 없음, 열어서 엑셀 선택)
  python tools/build_standalone.py --with-data → dist/공공영업대시보드_기준데이터포함.html (web_artifact/base_data.js 내장)
  --variant=v2 를 붙이면 제목·저장 공간을 분리한 별도 실행판(dist/공공영업대시보드_v2_성과활동점검*.html)

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


VARIANTS = {
    # 이름: (저장 공간 접미사, 제목, 사이드바 부제, 파일명 접미사)
    "v2": ("-v2", "공공영업 통합 대시보드 v2", "v2 · AM 성과·활동 점검 포함 · 브라우저 계산", "_v2_성과활동점검"),
}


def build(with_data: bool, variant: str | None = None) -> Path:
    page = (W / "index.html").read_text(encoding="utf-8")
    body = page
    vv = VARIANTS.get(variant) if variant else None
    if vv:
        body = body.replace("<title>공공영업 통합 대시보드</title>", f"<title>{vv[1]}</title>")
        body = body.replace("<h1>공공영업 통합 대시보드</h1>", f"<h1>{vv[1]}</h1>")
        body = re.sub(r"(<div><h1>[^<]*</h1><p>)[^<]*(</p>)", lambda m: m.group(1) + vv[2] + m.group(2), body)
    body = re.sub(r'<link rel="stylesheet" href="app\.css">\n?', "", body)
    body = re.sub(r'<script src="[^"]+"></script>\n?', "", body)
    title = re.search(r"<title>.*?</title>", body).group(0)
    body = body.replace(title, "")
    links = "".join(re.findall(r"<link [^>]+>\n?", body))
    body = re.sub(r"<link [^>]+>\n?", "", body)
    scripts = ["<script>window.PSD_STANDALONE = true;" + (f"window.PSD_VARIANT = {vv[0]!r};" if vv else "") + "</script>"]
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
    suf = vv[3] if vv else ""
    out = DIST / (f"공공영업대시보드{suf}_기준데이터포함.html" if with_data else f"공공영업대시보드{suf}.html")
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    var = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--variant=")), None)
    p = build("--with-data" in sys.argv, var)
    print(p, f"{p.stat().st_size / 1024 / 1024:.2f}MB")
