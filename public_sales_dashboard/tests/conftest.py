"""테스트 공통: 합성 Funnel 엑셀 생성 도구. 실제 회사 데이터는 사용하지 않는다."""
from __future__ import annotations

import datetime as dt
import os
import sys
from pathlib import Path

import pytest
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("LOG_DIR", str(ROOT / "logs" / "test"))

HEADERS = [
    "고객사", "수주년월", "월매출합계", "현재상황", "최근영업활동내용", "팀", "모듈", "AM", "ACR유형", "Culti 상세", "Ret.상세",
    "계약기간(월)", "매출발생년월", "Funnel번호", "본부", "연매출", "계약기간매출", "수주(재계약)가능성", "기존매출", "변경매출",
    "Biz1", "상품1", "월매출1", "Biz2", "상품2", "월매출2", "Biz3", "상품3", "월매출3", "Biz4", "상품4", "월매출4",
    "Biz5", "상품5", "월매출5", "최근영업활동내역 저장일시", "확정자", "확정일자", "재계약전략 등록여부", "입찰방식",
    "참가자격", "승패사유", "Drop세부사유", "해지사유", "해지유형", "입찰공고번호", "입찰공고명", "수주예상금액",
    "수주가능매출", "RMR제외", "중대형퍼널제외", "수주가능성 변경이력",
]

_seq = {"n": 0}


def row(**kw) -> dict:
    """기본값이 채워진 합성 행. 키는 한글 헤더 또는 축약 키."""
    _seq["n"] += 1
    alias = {"type": "ACR유형", "status": "현재상황", "win": "수주년월", "rev": "매출발생년월", "term": "계약기간(월)",
             "monthly": "월매출합계", "fid": "Funnel번호", "team": "팀", "am": "AM", "cust": "고객사",
             "contract": "계약기간매출", "prev": "기존매출", "new": "변경매출", "prob": "수주(재계약)가능성",
             "upd": "최근영업활동내역 저장일시", "strategy": "재계약전략 등록여부", "hq": "본부",
             "hist": "수주가능성 변경이력", "conf": "확정일자"}
    r = {
        "고객사": "테스트****", "수주년월": 202610, "월매출합계": 10, "현재상황": "Win", "팀": "공공고객팀", "AM": "가AM",
        "ACR유형": "Acq.", "계약기간(월)": 12, "매출발생년월": 202610, "Funnel번호": f"F{_seq['n']:06d}", "본부": "공공고객담당",
        "계약기간매출": 120, "기존매출": 0, "변경매출": 0, "수주(재계약)가능성": "100%(수주완료)",
        "최근영업활동내역 저장일시": "2026-10-20", "재계약전략 등록여부": "N", "RMR제외": "N", "중대형퍼널제외": "N",
    }
    for k, v in kw.items():
        r[alias.get(k, k)] = v
    if "월매출1" not in kw and "상품1" not in kw:
        r["Biz1"], r["상품1"], r["월매출1"] = "Core", "국내전용", r["월매출합계"]
    return r


def write_xlsx(path: Path, rows: list[dict], headers: list[str] | None = None, sheet="유선Funnel조회") -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    hs = headers or HEADERS
    ws.append(hs)
    for r in rows:
        ws.append([r.get(h) for h in hs])
    wb.save(path)
    return path


@pytest.fixture
def make_ds(tmp_path):
    from data_loader import build_dataset

    def _make(rows, **kw):
        p = write_xlsx(tmp_path / f"t{_seq['n']}.xlsx", rows, **kw)
        return build_dataset(p, p.name, "test")
    return _make


@pytest.fixture
def params():
    import analytics as A

    def _p(**kw):
        # 단건 금액 검증용으로 매출개시월 기준(start)을 명시. 기본값(term)은 test_default_mode_term에서 검증
        d = {"base_date": "2026-11-01", "ym_from": "2026-01", "ym_to": "2026-12", "mode": "start"}
        d.update(kw)
        return A.parse_params(d)
    return _p


@pytest.fixture
def base_date():
    return dt.date(2026, 11, 1)
