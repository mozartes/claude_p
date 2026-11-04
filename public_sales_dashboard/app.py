"""공공영업 통합 대시보드 — Flask 앱.

실행
  개발:  python app.py            (FLASK_DEBUG=1 이면 디버그)
  운영:  python serve.py          (waitress, Debug OFF)
URL_PREFIX 는 PrefixMiddleware 한 곳에서 처리한다(SCRIPT_NAME 설정 → url_for 가 자동으로 접두어 1회 부착).
"""
from __future__ import annotations

import datetime as dt
import io
import json
import logging
import time
from logging.handlers import RotatingFileHandler

import pandas as pd
from flask import Flask, Response, jsonify, redirect, render_template, request, send_file, url_for

import analytics as A
import config as C
import revenue as R
from data_loader import DataStore, LoadError

# ---------------------------------------------------------------- 로깅(고객명·활동 원문·인증정보는 기록하지 않음)


def setup_logging() -> None:
    C.LOG_DIR.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger("dashboard")
    if root.handlers:
        return
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    fh = RotatingFileHandler(C.LOG_DIR / "app.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root.addHandler(fh)
    root.addHandler(sh)


log = logging.getLogger("dashboard.app")


# ---------------------------------------------------------------- URL_PREFIX 처리


class PrefixMiddleware:
    """요청 경로가 prefix 로 시작하면 SCRIPT_NAME 으로 옮긴다.
    프록시가 prefix 를 이미 제거해 전달하는 경우에도 SCRIPT_NAME 을 prefix 로 설정해 링크가 올바르게 생성된다.
    (prefix 가 두 번 붙지 않도록 SCRIPT_NAME 이 이미 prefix 로 끝나면 그대로 둔다.)"""

    def __init__(self, app, prefix: str):
        self.app = app
        self.prefix = prefix

    def __call__(self, environ, start_response):
        if self.prefix:
            path = environ.get("PATH_INFO", "") or ""
            script = environ.get("SCRIPT_NAME", "") or ""
            if path == self.prefix or path.startswith(self.prefix + "/"):
                environ["PATH_INFO"] = path[len(self.prefix):] or "/"
            if not script.rstrip("/").endswith(self.prefix):
                environ["SCRIPT_NAME"] = script.rstrip("/") + self.prefix
        return self.app(environ, start_response)


# ---------------------------------------------------------------- 앱 팩토리


def create_app(store: DataStore | None = None, prefix: str | None = None) -> Flask:
    setup_logging()
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.config["MAX_CONTENT_LENGTH"] = int(C.MAX_UPLOAD_MB * 1024 * 1024) + 1024 * 64
    app.config["JSON_AS_ASCII"] = False
    app.json.ensure_ascii = False
    app.json.sort_keys = False
    pfx = C.normalize_prefix(C.URL_PREFIX if prefix is None else prefix)
    if store is None:
        store = DataStore(C.DATA_DIR)
        store.load_initial(C.DEFAULT_DATA_FILE)
    app.extensions["store"] = store
    app.wsgi_app = PrefixMiddleware(app.wsgi_app, pfx)

    def ds():
        return store.get()

    def check_admin():
        if not C.ADMIN_TOKEN:
            return None
        tok = request.headers.get("X-Admin-Token") or request.form.get("admin_token") or ""
        if tok != C.ADMIN_TOKEN:
            return jsonify({"ok": False, "error": "업로드 권한 토큰이 올바르지 않습니다."}), 403
        return None

    def params_from_request() -> A.Params:
        if request.method == "POST" and request.is_json:
            body = request.get_json(silent=True) or {}
            return A.resolve_product_group(ds(), A.parse_params(body.get("filters") or {}))
        raw = request.args.get("filters")
        try:
            return A.resolve_product_group(ds(), A.parse_params(json.loads(raw) if raw else {}))
        except (ValueError, TypeError):
            return A.parse_params({})

    def body() -> dict:
        if request.method == "POST" and request.is_json:
            return request.get_json(silent=True) or {}
        raw = request.args.get("q")
        try:
            return json.loads(raw) if raw else {}
        except ValueError:
            return {}

    def envelope(payload: dict, p: A.Params, t0: float, view: str) -> Response:
        d = ds()
        excluded = d.quality.get("agg_excluded_rows", 0) if not d.empty else 0
        out = {
            "ok": True, "view": view,
            "dataset": {"empty": d.empty, "file_name": d.meta.get("file_name"),
                        "uploaded_at": d.meta.get("uploaded_at"), "rows": d.meta.get("row_count", 0),
                        "agg_excluded_rows": excluded, "reason": d.meta.get("reason"),
                        "warnings": [] if d.empty else d.quality.get("warnings", [])},
            "applied": A.params_summary(p),
            "data": payload,
        }
        sec = time.perf_counter() - t0
        log.info("view=%s seconds=%.3f", view, sec)
        return jsonify(A.clean(out))

    # ---------------- 화면
    @app.get("/")
    def index():
        return render_template(
            "index.html",
            api_base=url_for("index").rstrip("/") + "/api",
            prefix=request.script_root,
            admin_required=bool(C.ADMIN_TOKEN),
        )

    @app.get("/healthz")
    def healthz():
        d = ds()
        return jsonify({"ok": True, "data_loaded": not d.empty, "rows": d.meta.get("row_count", 0)})

    # ---------------- 메타
    @app.get("/api/meta")
    def api_meta():
        d = ds()
        teams, ams, products, years = [], [], [], []
        if not d.empty:
            sc = d.df[d.df["in_scope"]]
            teams = sorted(sc["team"].unique().tolist())
            ams = [{"key": k, "team": k.split("|")[0], "am": k.split("|", 1)[1]}
                   for k in sorted(sc["am_key"].unique().tolist())]
            products = sorted({n for ns in sc["product_names"] for n in ns})
            years = sorted({int(v) // 100 for v in sc["win_ym"].dropna()})
        p = A.parse_params({})
        return jsonify(A.clean({
            "ok": True,
            "dataset": {"empty": d.empty, **d.meta},
            "options": {"teams": teams, "ams": ams, "products": products, "years": years,
                        "product_groups": C.PRODUCT_GROUPS, "leased_products": C.LEASED_PRODUCTS,
                        "modes": R.MODES, "types": C.ACR_TYPE_LABEL},
            "defaults": {"total_year": p.total_year, "version": f"period:{C.DEFAULT_YM_FROM}~{C.DEFAULT_YM_TO}",
                         "base_date": p.base_date.isoformat(), "ym_from": R.ym_label(p.ym_from),
                         "ym_to": R.ym_label(p.ym_to), "th": C.BUSINESS_DEFAULTS},
            "unit": {"source_unit": C.SOURCE_UNIT, "units": list(C.UNIT_FACTORS_TO_WON)},
            "rules": A.rules_table(p),
            "admin_required": bool(C.ADMIN_TOKEN),
            "settings": {"URL_PREFIX": C.URL_PREFIX or "(없음)", "TARGET_HQ": C.TARGET_HQ,
                         "MAX_UPLOAD_MB": C.MAX_UPLOAD_MB},
        }))

    VIEWS = {
        "overview": A.overview_view, "funnel": A.funnel_view, "renewal": A.renewal_view,
        "acr": A.acr_view, "presales": A.presales_view, "total": A.total_view, "team": A.team_view, "insight": A.insight_view, "quality": A.quality_view,
    }

    @app.route("/api/view/<name>", methods=["GET", "POST"])
    def api_view(name):
        if name not in VIEWS:
            return jsonify({"ok": False, "error": "알 수 없는 화면"}), 404
        t0 = time.perf_counter()
        p = params_from_request()
        d = ds()
        if d.empty and name != "quality":
            return envelope({"empty": True}, p, t0, name)
        try:
            payload = VIEWS[name](d, p)
        except Exception:
            log.exception("view failed: %s", name)
            return jsonify({"ok": False, "error": "집계 중 오류가 발생했습니다. logs/app.log 를 확인하세요."}), 500
        if name in ("overview", "funnel", "renewal", "team", "acr"):
            payload["rules"] = A.rules_table(p)
        return envelope(payload, p, t0, name)

    @app.route("/api/detail", methods=["GET", "POST"])
    def api_detail():
        t0 = time.perf_counter()
        p = params_from_request()
        b = body()
        d = ds()
        if d.empty:
            return envelope({"rows": [], "total": 0, "desc": "자료 없음"}, p, t0, "detail")
        res = A.detail_view(d, p, b.get("drill"), b.get("page", 1), b.get("size", 50),
                            b.get("sort", "row"), bool(b.get("desc")), str(b.get("q") or "")[:100])
        return envelope(res, p, t0, "detail")

    @app.get("/api/raw/<int:row>")
    def api_raw(row):
        d = ds()
        r = A.raw_row(d, row) if not d.empty else None
        if r is None:
            return jsonify({"ok": False, "error": "행을 찾을 수 없습니다."}), 404
        return jsonify(A.clean({"ok": True, "row": r}))

    # ---------------- 다운로드(현재 필터·드릴 결과)
    @app.route("/api/export", methods=["GET", "POST"])
    def api_export():
        t0 = time.perf_counter()
        if request.method == "POST" and not request.is_json:
            try:
                p = A.resolve_product_group(ds(), A.parse_params(json.loads(request.form.get("filters") or "{}")))
                b = json.loads(request.form.get("q") or "{}")
            except ValueError:
                p, b = A.parse_params({}), {}
        else:
            p, b = params_from_request(), body()
        d = ds()
        if d.empty:
            return jsonify({"ok": False, "error": "자료 없음"}), 400
        # 서버에서 단위가 확정되어 있으면 서버 설정 우선
        unit_src = C.SOURCE_UNIT if C.SOURCE_UNIT != "unknown" else (
            b.get("source_unit") if b.get("source_unit") in C.UNIT_FACTORS_TO_WON else "unknown")
        sel, ck, basis, desc = A.drill_rows(d, p, b.get("drill"))
        q = str(b.get("q") or "")[:100]
        rows = [A.row_record(sel.loc[i], ck.loc[i].to_dict(),
                             {"included": bool(basis.loc[i, "included"]), "reason": basis.loc[i, "excl_reason"]})
                for i in sel.index]
        if q:
            rows = [r for r in rows if q.lower() in " ".join(str(r.get(k) or "") for k in ("customer", "funnel_id", "am", "team")).lower()]
        cols = [("row", "원본행"), ("funnel_id", "Funnel번호"), ("customer", "고객사"), ("team", "팀"), ("am", "AM"),
                ("acr_type", "ACR유형"), ("status", "현재상황"), ("win_ym", "수주년월"), ("rev_ym", "매출발생년월"),
                ("term", "계약기간(월)"), ("monthly", "월매출합계"), ("contract_amt", "계약기간매출"),
                ("prev_monthly", "기존매출"), ("new_monthly", "변경매출"), ("prob", "수주(재계약)가능성"),
                ("products", "상품(월매출)"), ("updated_at", "최근 갱신일"), ("strategy_reg", "재계약전략 등록여부"),
                ("acr_included", "ACR 포함"), ("acr_excl_reason", "ACR 제외 사유"), ("checks", "확인 사유"),
                ("actions", "권장 확인 행동"), ("level", "우선순위 등급"), ("issues", "데이터 품질")]
        if unit_src != "unknown":  # 금액 열 이름에 단위 표기
            amt_keys = {"monthly", "contract_amt", "prev_monthly", "new_monthly"}
            cols = [(k, f"{lb}({unit_src})" if k in amt_keys else lb) for k, lb in cols]
        recs = []
        for r in rows:
            rec = {}
            for k, lb in cols:
                v = r.get(k)
                if isinstance(v, list):
                    v = ", ".join(v)
                if k == "acr_included":
                    v = "포함" if v else "제외"
                rec[lb] = v
            recs.append(rec)
        df = pd.DataFrame(recs, columns=[lb for _, lb in cols])
        summ = A.params_summary(p)
        cond = [("생성시각", dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                ("원본 파일", d.meta.get("file_name")), ("원본 업로드 시각", d.meta.get("uploaded_at")),
                ("목록 조건", desc), ("목록 내 검색", q or "없음"), ("행 수", len(df)),
                ("금액 단위", f"{unit_src} (원본 값 그대로, 반올림 없음)" if unit_src != "unknown" else "원본 단위·확인 필요(원본 값 그대로, 반올림 없음)")]
        cond += [(k, json.dumps(v, ensure_ascii=False) if isinstance(v, dict) else v) for k, v in summ.items()]
        cond += [("지표 정의: " + k, v) for k, v in {
            "확정 ACR": "A=Acq.+Win, C=Cul.+Win, R=Ret.+재계약완료; 월매출합계(증감액) 기준, 음수 유지",
            "매출개시월 기준": "월매출합계를 매출발생년월에 1회 배치",
            "계약기간 반영 추정": "매출발생년월부터 계약기간(월) 동안 매월 반영, 시작월 포함·일할 없음, 추정치",
            "중복": "Funnel번호 중복·누락 행은 검토 전 집계 제외(목록에는 표시)",
            "우선 확인": "설명 가능한 조건 규칙(수주 확률·AM 평가점수 아님)",
        }.items()]
        cond_df = pd.DataFrame(cond, columns=["항목", "값"])
        rules_df = pd.DataFrame(A.rules_table(p))
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as xw:
            df.to_excel(xw, sheet_name="목록", index=False)
            cond_df.to_excel(xw, sheet_name="조건_정의", index=False)
            rules_df.to_excel(xw, sheet_name="확인규칙", index=False)
        buf.seek(0)
        log.info("export rows=%d seconds=%.3f", len(df), time.perf_counter() - t0)
        fname = f"public_sales_{p.base_date.strftime('%Y%m%d')}_{dt.datetime.now().strftime('%H%M%S')}.xlsx"
        return send_file(buf, as_attachment=True, download_name=fname,
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    # ---------------- 업로드(검증 → 미리보기 → 적용)
    @app.post("/api/upload")
    def api_upload():
        deny = check_admin()
        if deny:
            return deny
        f = request.files.get("file")
        if f is None or not f.filename:
            return jsonify({"ok": False, "error": "파일을 선택하세요."}), 400
        try:
            res = store.stage(f, f.filename)
        except LoadError as e:
            return jsonify({"ok": False, "error": str(e)}), 400
        return jsonify(A.clean({"ok": True, **res}))

    @app.post("/api/upload/apply")
    def api_upload_apply():
        deny = check_admin()
        if deny:
            return deny
        token = (request.get_json(silent=True) or {}).get("token") or request.form.get("token") or ""
        try:
            d = store.apply(token)
        except LoadError as e:
            return jsonify({"ok": False, "error": str(e)}), 400
        except Exception:
            log.exception("apply failed")
            return jsonify({"ok": False, "error": "적용 중 오류가 발생해 기존 데이터를 유지합니다."}), 500
        return jsonify(A.clean({"ok": True, "meta": d.meta}))

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify({"ok": False, "error": f"파일 크기가 제한({C.MAX_UPLOAD_MB:.0f}MB)을 초과합니다."}), 413

    @app.get("/go-home")
    def go_home():  # redirect 경로 검증용
        return redirect(url_for("index"))

    return app


app = create_app() if __name__ != "__main__" else None

if __name__ == "__main__":
    application = create_app()
    application.run(host=C.HOST, port=C.PORT, debug=C.DEBUG)
