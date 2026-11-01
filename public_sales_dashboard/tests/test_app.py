"""업로드·검증·URL_PREFIX·다운로드 등 기능 검증."""
import io
import json

import pytest
from openpyxl import load_workbook

import data_loader as DL
from app import create_app
from conftest import HEADERS, row, write_xlsx


@pytest.fixture
def client_factory(tmp_path):
    def _f(prefix="", rows=None):
        store = DL.DataStore(tmp_path / "data")
        if rows is not None:
            p = write_xlsx(tmp_path / "init.xlsx", rows)
            tok = store.stage(io.BytesIO(p.read_bytes()), "init.xlsx")["token"]
            store.apply(tok)
        app = create_app(store=store, prefix=prefix)
        app.testing = True
        return app.test_client(), store
    return _f


def upload(c, base, path_or_bytes, name):
    data = path_or_bytes if isinstance(path_or_bytes, bytes) else path_or_bytes.read_bytes()
    return c.post(base + "/api/upload", data={"file": (io.BytesIO(data), name)}, content_type="multipart/form-data")


def test_parsers():
    assert DL.parse_ym(202611) == (202611, False)
    assert DL.parse_ym("2026-11") == (202611, False)
    assert DL.parse_ym("2026.1") == (202601, False)
    assert DL.parse_ym(46327)[0] == 202611  # Excel 일련번호(2026-10/11)
    assert DL.parse_ym("202613") == (None, True)
    assert DL.parse_ym(None) == (None, False)
    assert DL.parse_num("1,234.5") == (1234.5, False)
    assert DL.parse_num("abc") == (None, True)
    assert DL.parse_num("") == (None, False)
    assert DL.parse_num(-5) == (-5.0, False)
    assert DL.parse_prob("50%(중중)") == 50 and DL.parse_prob("1%(Tapping)") == 1
    assert DL.parse_prob("높음") is None and DL.parse_prob(None) is None
    assert DL.clean_str("  공공\n고객팀 ") == "공공 고객팀"


def test_raw_and_normalized_kept(make_ds):
    ds = make_ds([row(team="  공공고객팀\n", type=" Cul. ")])
    r = ds.raw_rows[0]
    assert r["팀"] == "  공공고객팀\n" and r["ACR유형"] == " Cul. "
    assert ds.df.iloc[0]["team"] == "공공고객팀" and ds.df.iloc[0]["acr_type"] == "C"


def test_quality_checks(make_ds):
    ds = make_ds([row(type="Xyz"), row(status="이상"), row(monthly="abc"), row(win="2026-13"),
                  row(term=0), row(team=None), row(am=None), row(monthly=10, 상품1="A", 월매출1=6),
                  row(type="Ret.", status="재계약완료", prev=10, new=9, monthly=-3)])
    codes = {i["code"] for i in ds.quality["issue_counts"]}
    assert {"TYPE_UNKNOWN", "STATUS_UNKNOWN", "NUM_ERROR", "YM_ERROR_WIN", "TERM_ZERO", "TEAM_MISSING", "AM_MISSING",
            "PRODUCT_SUM_DIFF", "R_AMOUNT_MISMATCH"} <= codes
    assert ds.quality["unknown_types"] == ["Xyz"] and ds.quality["unknown_statuses"] == ["이상"]
    assert (ds.df["team"] == "조직 미입력").sum() == 1


def test_upload_flow_and_failures_keep_data(client_factory, tmp_path):
    c, store = client_factory(rows=[row(monthly=1, rev=202603)])
    before = store.get()
    # 잘못된 확장자
    r = upload(c, "", b"hello", "x.csv")
    assert r.status_code == 400 and "확장자" in r.get_json()["error"]
    # 손상 파일
    r = upload(c, "", b"PK\x03\x04garbage", "x.xlsx")
    assert r.status_code == 400
    # 필수 열 누락
    bad = write_xlsx(tmp_path / "bad.xlsx", [row()], headers=[h for h in HEADERS if h != "매출발생년월"])
    r = upload(c, "", bad, "bad.xlsx")
    assert r.status_code == 400 and "매출발생년월" in r.get_json()["error"]
    assert store.get() is before  # 실패 후 기존 데이터 유지
    # 정상 업로드 → 미리보기 → 적용
    good = write_xlsx(tmp_path / "good.xlsx", [row(fid="D1"), row(fid="D1"), row()])
    r = upload(c, "", good, "../../good name.xlsx")
    j = r.get_json()
    assert j["ok"] and j["quality"]["dup_group_count"] == 1
    assert store.get() is before  # 적용 전 변화 없음
    r = c.post("/api/upload/apply", json={"token": j["token"]})
    assert r.get_json()["ok"]
    assert store.get().meta["row_count"] == 3
    saved = list((tmp_path / "data" / "raw").glob("*.xlsx"))
    assert len(saved) == 2 and all(".." not in p.name and " " not in p.name for p in saved)
    # 같은 토큰 재적용 불가, 잘못된 토큰
    assert c.post("/api/upload/apply", json={"token": j["token"]}).status_code == 400
    assert c.post("/api/upload/apply", json={"token": "../x"}).status_code == 400
    # 재시작 시 마지막 적용본 로드
    s2 = DL.DataStore(tmp_path / "data")
    s2.load_initial()
    assert s2.get().meta["row_count"] == 3


def test_empty_state(client_factory):
    c, _ = client_factory()
    j = c.post("/api/view/overview", json={"filters": {}}).get_json()
    assert j["ok"] and j["data"]["empty"] and j["dataset"]["empty"]
    assert c.get("/api/meta").get_json()["dataset"]["empty"]


@pytest.mark.parametrize("prefix", ["", "/public-acr"])
def test_prefix_routes(client_factory, tmp_path, prefix):
    c, _ = client_factory(prefix=prefix, rows=[row(monthly=2, rev=202603)])
    html = c.get(prefix + "/").get_data(as_text=True)
    assert f'href="{prefix}/static/css/app.css"' in html
    assert f'src="{prefix}/static/js/app.js"' in html
    assert f'src="{prefix}/static/vendor/chart.umd.min.js"' in html
    assert f'data-api="{prefix}/api"' in html
    assert "//static" not in html and "/public-acr/public-acr" not in html
    assert c.get(prefix + "/static/vendor/chart.umd.min.js").status_code == 200
    assert c.get(prefix + "/static/css/app.css").status_code == 200
    assert c.get(prefix + "/api/meta").get_json()["ok"]
    assert c.post(prefix + "/api/view/acr", json={"filters": {}}).get_json()["data"]["totals"]["ACR"] == 2
    r = c.get(prefix + "/go-home")
    assert r.status_code == 302 and r.headers["Location"].endswith(prefix + "/")
    good = write_xlsx(tmp_path / "g2.xlsx", [row()])
    assert upload(c, prefix, good, "g2.xlsx").get_json()["ok"]
    r = c.post(prefix + "/api/export", data={"filters": "{}", "q": json.dumps({"drill": {"scope": "acr"}})})
    assert r.status_code == 200 and r.data[:2] == b"PK"


def test_export_contents_match(client_factory):
    c, _ = client_factory(rows=[row(monthly=3, rev=202603), row(type="Cul.", monthly=4, rev=202604),
                                row(status="Pre Sales", monthly=9, rev=202604)])
    acr = c.post("/api/view/acr", json={"filters": {}}).get_json()["data"]["totals"]
    r = c.post("/api/export", json={"filters": {}, "drill": {"scope": "acr"}})
    wb = load_workbook(io.BytesIO(r.data))
    ws = wb["목록"]
    hdr = [x.value for x in ws[1]]
    vals = [rw[hdr.index("월매출합계")] for rw in ws.iter_rows(min_row=2, values_only=True)]
    assert len(vals) == acr["funnels"] and sum(vals) == acr["ACR"]
    cond = {rw[0]: rw[1] for rw in wb["조건_정의"].iter_rows(min_row=2, values_only=True)}
    assert "기준일" in cond and "조회기간" in cond and "금액 단위" in cond and any(k.startswith("지표 정의") for k in cond)


def test_admin_token(client_factory, tmp_path, monkeypatch):
    import config as C
    monkeypatch.setattr(C, "ADMIN_TOKEN", "secret-test")
    c, _ = client_factory()
    good = write_xlsx(tmp_path / "g3.xlsx", [row()])
    assert upload(c, "", good, "g3.xlsx").status_code == 403
    r = c.post("/api/upload", data={"file": (io.BytesIO(good.read_bytes()), "g3.xlsx")},
               headers={"X-Admin-Token": "secret-test"}, content_type="multipart/form-data")
    assert r.get_json()["ok"]
    # 조회는 토큰 없이 가능
    assert c.get("/api/meta").status_code == 200


def test_detail_paging_sort_search(client_factory):
    c, _ = client_factory(rows=[row(cust=f"고객{i:02d}", monthly=i) for i in range(25)])
    j = c.post("/api/detail", json={"filters": {}, "page": 2, "size": 10, "sort": "monthly", "desc": True}).get_json()["data"]
    assert j["total"] == 25 and j["page"] == 2 and j["pages"] == 3 and j["rows"][0]["monthly"] == 14
    j = c.post("/api/detail", json={"filters": {}, "q": "고객07"}).get_json()["data"]
    assert j["total"] == 1
    assert c.get("/api/raw/2").get_json()["row"]["고객사"] == "고객00"
