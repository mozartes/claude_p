"""영업관리 분석 — 필터, 화면별 집계, 우선 확인 규칙, 상세 목록.

모든 화면은 이 모듈의 함수와 revenue.compute_acr 만 사용해 같은 기준으로 계산된다.
금액은 원본 단위 그대로 반환하며 단위 변환·반올림은 표시 단계(브라우저/엑셀)에서만 한다.
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

import config as C
import revenue as R
from data_loader import ISSUE_LABELS, Dataset, customer_fill_warning

# ================================================================ 파라미터


@dataclass
class Params:
    base_date: dt.date
    ym_from: int
    ym_to: int
    level: str = "all"
    teams: list[str] = field(default_factory=list)
    ams: list[str] = field(default_factory=list)
    types: list[str] = field(default_factory=lambda: ["A", "C", "R"])
    products: list[str] = field(default_factory=list)
    product_group: str = "all"
    user_products: list[str] = field(default_factory=list)
    search: str = ""
    mode: str = "start"
    excl_midlarge: bool = False
    excl_rmr: bool = False
    confirmed_only: bool = False
    th: dict = field(default_factory=lambda: dict(C.BUSINESS_DEFAULTS))

    @property
    def base_ym(self) -> int:
        return self.base_date.year * 100 + self.base_date.month


def default_base_date() -> dt.date:
    if C.BASE_DATE:
        try:
            return dt.date.fromisoformat(C.BASE_DATE)
        except ValueError:
            pass
    return dt.date.today()


def _ym_from_str(v: Any) -> int | None:
    if v is None or v == "":
        return None
    s = str(v).replace("-", "")
    if len(s) == 6 and s.isdigit():
        y, m = int(s[:4]), int(s[4:])
        if 1990 <= y <= 2100 and 1 <= m <= 12:
            return y * 100 + m
    return None


def _list(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [x for x in v.split(",") if x]
    return [str(x) for x in v if x not in (None, "")]


def parse_params(d: dict | None) -> Params:
    d = d or {}
    try:
        base = dt.date.fromisoformat(str(d.get("base_date"))) if d.get("base_date") else default_base_date()
    except ValueError:
        base = default_base_date()
    y = base.year
    ym_from = _ym_from_str(d.get("ym_from")) or _ym_from_str(C.DEFAULT_YM_FROM) or y * 100 + 1
    ym_to = _ym_from_str(d.get("ym_to")) or _ym_from_str(C.DEFAULT_YM_TO) or y * 100 + 12
    if ym_from > ym_to:
        ym_from, ym_to = ym_to, ym_from
    if R.ym_diff(ym_from, ym_to) > 120:  # 과도한 범위 방지(10년)
        ym_to = R.ym_add(ym_from, 120)
    th = dict(C.BUSINESS_DEFAULTS)
    for k, v in (d.get("th") or {}).items():
        if k in th:
            try:
                fv = float(v)
                if math.isfinite(fv) and fv >= 0:
                    th[k] = int(fv) if k in ("stale_days", "imminent_months") else fv
            except (TypeError, ValueError):
                pass
    types = [t for t in _list(d.get("types")) if t in ("A", "C", "R")] or ["A", "C", "R"]
    level = d.get("level") if d.get("level") in ("all", "team", "am") else "all"
    return Params(
        base_date=base, ym_from=ym_from, ym_to=ym_to, level=level,
        teams=_list(d.get("teams")), ams=_list(d.get("ams")), types=types,
        products=_list(d.get("products")), user_products=_list(d.get("products")),
        product_group=d.get("product_group") if d.get("product_group") in C.PRODUCT_GROUPS else "all",
        search=str(d.get("search") or "").strip()[:100],
        mode=d.get("mode") if d.get("mode") in R.MODES else "start",
        excl_midlarge=bool(d.get("excl_midlarge")), excl_rmr=bool(d.get("excl_rmr")),
        confirmed_only=bool(d.get("confirmed_only")), th=th,
    )


def leased_set() -> set[str]:
    return set(C.LEASED_PRODUCTS)


def resolve_product_group(ds: Dataset, p: Params) -> Params:
    """상품 카테고리를 실제 상품 목록으로 풀어 p.products 에 반영(개별 상품 선택이 있으면 교집합)."""
    p.products = list(p.user_products)
    if p.product_group == "all" or ds.empty:
        return p
    sc = ds.df[ds.df["in_scope"]]
    universe = sorted({n for ns in sc["product_names"] for n in ns})
    lz = leased_set()
    grp = [n for n in universe if (n in lz) == (p.product_group == "leased")]
    chosen = [x for x in p.user_products if x in grp] if p.user_products else grp
    p.products = chosen or [C.NO_PRODUCT_MATCH]
    return p


def product_summary(p: Params) -> str:
    if p.product_group == "all":
        return ", ".join(p.user_products) or "전체(월매출합계 사용)"
    if p.user_products:
        real = [x for x in p.products if x != C.NO_PRODUCT_MATCH]
        return ", ".join(real) or "카테고리에 해당하는 선택 상품 없음"
    return f"{C.PRODUCT_GROUPS[p.product_group]} {len(p.products)}개 상품" if p.products != [C.NO_PRODUCT_MATCH] else "해당 상품 없음"


def params_summary(p: Params) -> dict:
    return {
        "기준일": p.base_date.isoformat(),
        "조회기간": f"{R.ym_label(p.ym_from)} ~ {R.ym_label(p.ym_to)}",
        "집계 수준": {"all": "담당 전체", "team": "팀", "am": "AM"}[p.level],
        "팀": ", ".join(p.teams) or "전체",
        "AM": ", ".join(a.split("|")[-1] + f"({a.split('|')[0]})" for a in p.ams) or "전체",
        "ACR유형": ", ".join(p.types),
        "상품 카테고리": C.PRODUCT_GROUPS[p.product_group],
        "상품": product_summary(p),
        "검색": p.search or "없음",
        "ACR 기준": R.MODES[p.mode],
        "보조필터": ", ".join(x for x, on in [
            ("중대형퍼널제외=Y 제외", p.excl_midlarge), ("RMR제외=Y 제외", p.excl_rmr),
            ("확정자 입력 건만", p.confirmed_only)] if on) or "미적용",
        "업무 기준": p.th,
    }


# ================================================================ 공통 필터


def filter_df(ds: Dataset, p: Params, include_excluded: bool = False) -> pd.DataFrame:
    """조직·유형·상품·검색·보조필터 적용. 상태·기간은 각 지표 정의에서 적용한다.
    include_excluded=False 이면 Funnel번호 중복·누락 행(검토 대상)은 집계에서 뺀다."""
    if ds.empty:
        return pd.DataFrame()
    df = ds.df
    m = df["in_scope"].copy()
    if not include_excluded:
        m &= ~df["agg_excluded"]
    if p.teams:
        m &= df["team"].isin(p.teams)
    if p.ams:
        m &= df["am_key"].isin(p.ams)
    if p.types and set(p.types) != {"A", "C", "R"}:
        m &= df["acr_type"].isin(p.types)
    if p.products:
        sel = set(p.products)
        m &= df["product_names"].apply(lambda ns: bool(sel.intersection(ns)))
    if p.search:
        q = p.search.lower()
        m &= df["customer"].fillna("").str.lower().str.contains(q, regex=False) | \
            df["funnel_id"].fillna("").str.lower().str.contains(q, regex=False)
    if p.excl_midlarge:
        m &= df["midlarge_excl"].fillna("") != "Y"
    if p.excl_rmr:
        m &= df["rmr_excl"].fillna("") != "Y"
    if p.confirmed_only:
        m &= df["confirmer"].notna()
    return df[m]


def in_period(s: pd.Series, p: Params) -> pd.Series:
    return s.notna() & (s >= p.ym_from) & (s <= p.ym_to)


def fsum(s: pd.Series) -> float | None:
    """누락만 있으면 None(자료 없음), 하나라도 있으면 합계(0 포함)."""
    s = pd.to_numeric(s, errors="coerce")
    return float(s.sum()) if s.notna().any() else None


def amount_split(s: pd.Series) -> dict:
    s = pd.to_numeric(s, errors="coerce")
    return {
        "total": fsum(s), "positive": float(s[s > 0].sum()), "negative": float(s[s < 0].sum()),
        "pos_count": int((s > 0).sum()), "zero_count": int((s == 0).sum()), "neg_count": int((s < 0).sum()),
        "missing_count": int(s.isna().sum()),
    }


# ================================================================ 일정·갱신 판정

BUCKETS = ["이번 달", "다음 달", "이후", "예정월 경과", "예정월 미입력"]


def schedule_bucket(win_ym: pd.Series, p: Params) -> pd.Series:
    base, nxt = p.base_ym, R.ym_add(p.base_ym, 1)

    def f(v):
        if v is None or pd.isna(v):
            return "예정월 미입력"
        v = int(v)
        if v < base:
            return "예정월 경과"
        if v == base:
            return "이번 달"
        if v == nxt:
            return "다음 달"
        return "이후"
    return win_ym.apply(f)


def update_state(df: pd.DataFrame, p: Params) -> pd.DataFrame:
    base = pd.Timestamp(p.base_date)
    days = (base - df["updated_at"]).dt.days
    out = pd.DataFrame(index=df.index)
    out["days"] = days
    out["missing"] = df["updated_at"].isna()
    out["future"] = df["updated_at"] > base
    out["stale"] = days > p.th["stale_days"]
    return out


# ================================================================ 우선 확인 규칙

RULES = [
    # code, level(1=높음), label, action, 조건 설명
    ("OVERDUE", 1, "예정월 경과", "수주(재계약) 일정·현재 단계 확인",
     "진행 중(Pre Sales·제안완료) & 수주년월 < 기준월"),
    ("WIN_NO_REV", 1, "Win·매출발생년월 누락", "개통·매출 개시 일정 확인", "Win & 매출발생년월 없음"),
    ("RENEWAL_DECREASE", 1, "재계약 감액 예상", "감액 사유·방어 방안 확인",
     "R 진행 중 & (변경매출 < 기존매출 또는 월매출합계 < 0)"),
    ("LARGE_STALE", 1, "대형 사업·장기 미갱신", "진행상황·다음 활동 갱신",
     "진행 중 & 대형(A/C 계약기간매출 ≥ 기준, R 기존 월매출 ≥ 기준) & (미갱신 또는 갱신일 미입력)"),
    ("PROPOSAL_IMMINENT", 2, "제안완료·예정월 임박", "평가·계약 일정 확인",
     "제안완료 & 기준월 ≤ 수주년월 ≤ 기준월+임박개월"),
    ("HIGH_PROB_PRESALES", 2, "높은 입력 가능성·Pre Sales", "단계 갱신 또는 가능성 재확인",
     "Pre Sales & 수주(재계약)가능성 ≥ 기준%"),
    ("LARGE_RENEWAL", 2, "기존 월매출 큰 진행 중 재계약", "재계약 대응계획 확인",
     "R 진행 중 & 기존매출 ≥ 대형 재계약 기준"),
    ("STALE", 2, "장기 미갱신", "진행상황·다음 활동 갱신",
     "진행 중 & 기준일 − 최근영업활동내역 저장일시 > 미갱신 기준일수"),
    ("UPDATE_MISSING", 2, "갱신일 미입력", "최근 활동 내역 등록", "진행 중 & 저장일시 없음"),
    ("STRATEGY_MISSING", 3, "재계약전략 미등록", "대응계획 확인·전략 등록",
     "R 진행 중 & 재계약전략 등록여부 ≠ Y(N 또는 미입력)"),
    ("REV_BEFORE_WIN", 3, "매출발생년월이 수주년월보다 이전", "일정 입력 기준 확인",
     "Drop·Lose 제외 & 매출발생년월 < 수주년월 (자동 오류 확정 아님)"),
    ("WIN_FUTURE_REV", 3, "Win·매출개시 미래", "개통·매출 개시 예정 확인", "Win & 매출발생년월 > 기준월"),
    ("UPDATE_FUTURE", 3, "갱신일이 기준일 이후", "갱신일·기준일 확인", "저장일시 > 기준일"),
    ("AMOUNT_MISMATCH", 3, "금액 불일치", "원본 입력 기준 확인",
     "상품별 월매출 합계 ≠ 월매출합계 또는 R의 변경−기존 ≠ 월매출합계"),
]
RULE_MAP = {r[0]: r for r in RULES}


def compute_checks(df: pd.DataFrame, p: Params) -> pd.DataFrame:
    """행별 확인 사유(코드 목록)·우선순위·금액 기준. 한 Funnel은 한 행에 사유를 모아 표시."""
    if df.empty:
        return pd.DataFrame(columns=["codes", "level", "amount", "amount_basis"])
    st, t = df["status"], df["acr_type"]
    prog = st.isin(C.IN_PROGRESS)
    is_r = t == "R"
    upd = update_state(df, p)
    th = p.th
    base = p.base_ym
    imm_hi = R.ym_add(base, int(th["imminent_months"]))
    win = df["win_ym"]
    rev = df["rev_ym"]
    large = (~is_r & (df["contract_amt"] >= th["large_contract_amount"])) | \
            (is_r & (df["prev_monthly"] >= th["large_renewal_monthly"]))
    stale_or_missing = upd["stale"].fillna(False) | upd["missing"]
    decrease = is_r & prog & (
        ((df["new_monthly"] < df["prev_monthly"]) & df["new_monthly"].notna() & df["prev_monthly"].notna())
        | (df["monthly"] < 0))
    issues = df["issues"]
    cond = {
        "OVERDUE": prog & win.notna() & (win < base),
        "WIN_NO_REV": (st == "Win") & rev.isna(),
        "RENEWAL_DECREASE": decrease,
        "LARGE_STALE": prog & large.fillna(False) & stale_or_missing,
        "PROPOSAL_IMMINENT": (st == "제안완료") & win.notna() & (win >= base) & (win <= imm_hi),
        "HIGH_PROB_PRESALES": (st == "Pre Sales") & (df["prob"] >= th["high_probability"]),
        "LARGE_RENEWAL": is_r & prog & (df["prev_monthly"] >= th["large_renewal_monthly"]),
        "STALE": prog & upd["stale"].fillna(False),
        "UPDATE_MISSING": prog & upd["missing"],
        "STRATEGY_MISSING": is_r & prog & (df["strategy_reg"].fillna("") != "Y"),
        "REV_BEFORE_WIN": ~st.isin(["Drop", "Lose"]) & rev.notna() & win.notna() & (rev < win),
        "WIN_FUTURE_REV": (st == "Win") & rev.notna() & (rev > base),
        "UPDATE_FUTURE": upd["future"].fillna(False),
        "AMOUNT_MISMATCH": issues.apply(lambda x: "PRODUCT_SUM_DIFF" in x or "R_AMOUNT_MISMATCH" in x),
    }
    codes = pd.Series([[] for _ in range(len(df))], index=df.index, dtype=object)
    for code, *_ in RULES:
        mask = cond[code].fillna(False).astype(bool)
        for i in df.index[mask]:
            codes.at[i].append(code)
    out = pd.DataFrame(index=df.index)
    out["codes"] = codes
    out["level"] = codes.apply(lambda cs: min((RULE_MAP[c][1] for c in cs), default=None))
    # 사유에 대응하는 금액·기준
    amt = pd.Series(np.nan, index=df.index)
    basis = pd.Series("", index=df.index, dtype=object)
    m_ac_prog = prog & ~is_r
    m_r_prog = prog & is_r
    m_done = ~prog
    amt[m_ac_prog] = df.loc[m_ac_prog, "contract_amt"]
    basis[m_ac_prog] = "계약기간매출"
    amt[m_r_prog] = df.loc[m_r_prog, "prev_monthly"]
    basis[m_r_prog] = "기존 월매출"
    amt[m_done] = df.loc[m_done, "monthly"]
    basis[m_done] = "월매출합계(증감)"
    out["amount"] = amt
    out["amount_basis"] = basis
    return out


def checks_with_rows(df: pd.DataFrame, p: Params) -> pd.DataFrame:
    ck = compute_checks(df, p)
    if ck.empty:
        return ck
    ck = ck[ck["codes"].apply(len) > 0]
    return ck


# ================================================================ 행 직렬화


def _v(x):
    if x is None:
        return None
    if isinstance(x, (float, np.floating)):
        return None if not math.isfinite(float(x)) else float(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if x is pd.NA or x is pd.NaT:
        return None
    if isinstance(x, pd.Timestamp):
        return x.strftime("%Y-%m-%d")
    try:
        if pd.isna(x):
            return None
    except (TypeError, ValueError):
        pass
    return x


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return _v(o)


def products_text(ps: list[dict]) -> str:
    out = []
    for x in ps:
        amt = "" if x.get("amount") is None else f" {x['amount']:g}"
        out.append(f"{x.get('product') or '(상품 미입력)'}{amt}")
    return "; ".join(out)


def _lvl(v):
    try:
        return None if v is None or pd.isna(v) else int(v)
    except (TypeError, ValueError):
        return None


def row_record(r: pd.Series, ck: dict | None = None, acr: dict | None = None) -> dict:
    codes = (ck or {}).get("codes") or []
    return {
        "row": int(r["row"]),
        "funnel_id": r["funnel_id"],
        "customer": r["customer"],
        "team": r["team"], "am": r["am"], "am_key": r["am_key"],
        "acr_type": r["acr_type"] if isinstance(r["acr_type"], str) else r["acr_raw"],
        "status": r["status"],
        "win_ym": R.ym_label(r["win_ym"]),
        "rev_ym": R.ym_label(r["rev_ym"]),
        "term": _v(r["term"]) if not pd.isna(r["term"]) else r["term_raw"],
        "monthly": _v(r["monthly"]),
        "contract_amt": _v(r["contract_amt"]),
        "prev_monthly": _v(r["prev_monthly"]),
        "new_monthly": _v(r["new_monthly"]),
        "prob": r["prob_raw"],
        "products": products_text(r["products"]),
        "updated_at": _v(r["updated_at"]),
        "strategy_reg": r["strategy_reg"],
        "bid_no": r["bid_no"], "bid_name": r["bid_name"], "bid_method": r["bid_method"],
        "acr_included": None if acr is None else acr.get("included"),
        "acr_excl_reason": None if acr is None else acr.get("reason"),
        "agg_excluded": bool(r["agg_excluded"]),
        "issues": [ISSUE_LABELS.get(i, i) for i in r["issues"] if i != "OUT_OF_SCOPE_HQ"],
        "check_codes": codes,
        "checks": [RULE_MAP[c][2] for c in codes],
        "actions": list(dict.fromkeys(RULE_MAP[c][3] for c in codes)),
        "level": _lvl((ck or {}).get("level")),
        "check_amount": (ck or {}).get("amount"),
        "check_amount_basis": (ck or {}).get("amount_basis"),
    }


# ================================================================ 화면: ACR


def acr_view(ds: Dataset, p: Params) -> dict:
    df = filter_df(ds, p)
    if df.empty:
        return {"empty": True}
    res = R.compute_acr(df, p.mode, p.ym_from, p.ym_to, p.products, p.types)
    res["basis"] = {
        "기간 기준": "매출발생년월" if p.mode == "start" else "매출발생년월부터 계약기간(월) 동안 매월 반영(시작월 포함)",
        "확정 조건": "A=Acq.+Win, C=Cul.+Win, R=Ret.+재계약완료",
        "금액": ("선택 상품·카테고리의 대응 월매출(상품1~5 슬롯 합)" if p.products else "월매출합계"),
        "상품 카테고리": C.PRODUCT_GROUPS[p.product_group] + (" — 전용회선 + 전용회선외 = 상품별 월매출 합계(월매출합계와 다른 행은 데이터 품질에 표시)" if p.product_group != "all" else ""),
        "R 해석": "월매출합계 = 재계약 증감액(음수 유지). 재계약 후 월매출(변경매출)은 합산하지 않음",
        "누적": f"선택기간 시작월({R.ym_label(p.ym_from)})부터 누적",
        "Funnel 건수": "월별 반복 반영 횟수가 아닌 고유 Funnel 수",
        "주의": "계약기간 반영값은 현재 입력 상태·일정 기반 추정이며 청구·회계 실적이 아님" if p.mode == "term"
        else "해당 월에 시작되는 월매출 증감 규모이며 반복 청구 매출·회계 실적이 아님",
    }
    return res


# ================================================================ 화면: 종합 현황


def overview_view(ds: Dataset, p: Params) -> dict:
    df = filter_df(ds, p)
    if df.empty:
        return {"empty": True}
    acr = R.compute_acr(df, p.mode, p.ym_from, p.ym_to, p.products, ["A", "C", "R"])
    prog = df[df["status"].isin(C.IN_PROGRESS)]
    prog_ac = prog[prog["acr_type"].isin(["A", "C"])]
    prog_r = prog[prog["acr_type"] == "R"]
    churn = df[(df["status"] == "해지확정") & in_period(df["win_ym"], p)]
    ck = checks_with_rows(df, p)
    sched = schedule_bucket(prog["win_ym"], p)

    def rows_of(sub: pd.DataFrame, limit=15):
        cks = compute_checks(sub, p) if not sub.empty else None
        out = []
        for i, r in sub.head(limit).iterrows():
            out.append(row_record(r, None if cks is None else cks.loc[i].to_dict()))
        return out

    upcoming = prog[sched.isin(["이번 달", "다음 달"])].sort_values(["win_ym", "contract_amt"], ascending=[True, False], kind="mergesort")
    overdue = prog[sched == "예정월 경과"].sort_values("win_ym", kind="mergesort")
    r_dec = prog_r[(prog_r["new_monthly"] < prog_r["prev_monthly"]) | (prog_r["monthly"] < 0)]
    team_checks = []
    if not ck.empty:
        j = df.loc[ck.index, ["team", "am_key", "am"]].join(ck)
        key = "am_key" if p.level == "am" else "team"
        for k, g in j.groupby(key):
            cnt = {}
            for cs in g["codes"]:
                for c in cs:
                    cnt[c] = cnt.get(c, 0) + 1
            team_checks.append({"key": k, "team": g["team"].iloc[0], "am": g["am"].iloc[0] if key == "am_key" else None,
                                "funnels": int(len(g)), "level1": int((g["level"] == 1).sum()),
                                "by_code": cnt})
        team_checks.sort(key=lambda x: (-x["level1"], -x["funnels"]))
    return {
        "kpi": {
            "acr": acr["totals"],
            "acr_mode_label": R.MODES[p.mode],
            "prog_ac_count": int(len(prog_ac)),
            "prog_ac_amount": amount_split(prog_ac["contract_amt"]),
            "prog_r_count": int(len(prog_r)),
            "prog_r_prev": fsum(prog_r["prev_monthly"]),
            "churn_count": int(len(churn)),
            "check_count": int(len(ck)),
            "check_level1": int((ck["level"] == 1).sum()) if not ck.empty else 0,
        },
        "acr_monthly": acr["monthly"],
        "acr_excluded": acr["excluded"],
        "upcoming": rows_of(upcoming, 20),
        "upcoming_count": int(len(upcoming)),
        "overdue": rows_of(overdue, 20),
        "overdue_count": int(len(overdue)),
        "renewal_decrease": rows_of(r_dec, 10),
        "renewal_decrease_count": int(len(r_dec)),
        "churn": rows_of(churn.sort_values("prev_monthly", ascending=False, kind="mergesort"), 10),
        "team_checks": team_checks,
        "priority": priority_rows(df, p, ck, limit=20),
        "basis": {
            "ACR": f"{R.MODES[p.mode]} · 매출발생년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)}",
            "진행 중": "현재상황 Pre Sales·제안완료 전체(기간 필터 미적용, 현재 상태 기준)",
            "진행 중 금액": "A/C 계약기간매출 / R 기존 월매출(원본값, 다른 열로 대체 안 함)",
            "해지확정": f"수주년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)} (해지월 아님)",
            "수주 예정": f"수주년월을 수주 예정월로 사용(업무 가정), 기준월 {R.ym_label(p.base_ym)}",
            "확인 필요": "우선 확인 규칙 1개 이상 해당 고유 Funnel(기간 무관)",
        },
    }


# ================================================================ 우선 확인 목록


def priority_rows(df: pd.DataFrame, p: Params, ck: pd.DataFrame | None = None, limit: int | None = None,
                  codes: list[str] | None = None) -> list[dict]:
    if ck is None:
        ck = checks_with_rows(df, p)
    if ck.empty:
        return []
    if codes:
        ck = ck[ck["codes"].apply(lambda cs: bool(set(cs) & set(codes)))]
    j = ck.assign(n=ck["codes"].apply(len), a=ck["amount"].abs().fillna(-1))
    j = j.sort_values(["level", "n", "a"], ascending=[True, False, False])
    if limit:
        j = j.head(limit)
    out = []
    for rank, (i, c) in enumerate(j.iterrows(), start=1):
        rec = row_record(df.loc[i], c.to_dict())
        rec["rank"] = rank
        out.append(rec)
    return out


def rules_table(p: Params) -> list[dict]:
    th = p.th
    return [{"code": c, "level": lv, "label": lb, "action": ac, "condition": cd} for c, lv, lb, ac, cd in RULES] + [
        {"code": "_TH", "level": None, "label": "적용 기준값", "action": "",
         "condition": f"미갱신 {th['stale_days']}일 초과 / 대형 A·C 계약기간매출 ≥ {th['large_contract_amount']:g} / "
                      f"대형 R 기존 월매출 ≥ {th['large_renewal_monthly']:g} / 임박 기준월+{th['imminent_months']}개월 / "
                      f"높은 가능성 ≥ {th['high_probability']:g}% (금액은 원본 단위)"}]


# ================================================================ 화면: 수주·Funnel


PROB_BINS = [("0%", 0, 0), ("1~29%", 1, 29.999), ("30~49%", 30, 49.999), ("50~69%", 50, 69.999),
             ("70~89%", 70, 89.999), ("90~100%", 90, 100)]


def prob_bin(v) -> str:
    if v is None or pd.isna(v):
        return "미확인"
    for lb, lo, hi in PROB_BINS:
        if lo <= v <= hi:
            return lb
    return "미확인"


def reason_table(s: pd.Series) -> dict:
    total = int(len(s))
    vc = s.fillna("(미입력)").value_counts()
    missing = int(s.isna().sum())
    return {"total": total, "missing": missing, "missing_ratio": (missing / total) if total else None,
            "items": [{"reason": k, "count": int(v)} for k, v in vc.items()]}


def funnel_view(ds: Dataset, p: Params) -> dict:
    df = filter_df(ds, p)
    if df.empty:
        return {"empty": True}
    ac = df[df["acr_type"].isin(["A", "C"])]
    rr = df[df["acr_type"] == "R"]
    # ① 현재 단계 분포(수주년월 기간 내)
    stage = []
    acp = ac[in_period(ac["win_ym"], p)]
    for s in ["Pre Sales", "제안완료", "Win", "Lose", "Drop"]:
        g = acp[acp["status"] == s]
        stage.append({"status": s, "count": int(len(g)), "amount": fsum(g["contract_amt"])})
    stage_r = []
    rp = rr[in_period(rr["win_ym"], p)]
    for s in ["Pre Sales", "제안완료", "재계약완료", "해지확정"]:
        g = rp[rp["status"] == s]
        stage_r.append({"status": s, "count": int(len(g)), "prev": fsum(g["prev_monthly"]),
                        "new": fsum(g["new_monthly"]), "monthly": fsum(g["monthly"])})
    # ② 수주 예정 일정(진행 중 A/C, 기간 무관)
    prog_ac = ac[ac["status"].isin(C.IN_PROGRESS)]
    b = schedule_bucket(prog_ac["win_ym"], p)
    sched = []
    for k in BUCKETS:
        g = prog_ac[b == k]
        sched.append({"bucket": k, "count": int(len(g)), "amount": amount_split(g["contract_amt"])})
    # ③ 확인 필요(진행 중 A/C + Win 일정 특이)
    ck = checks_with_rows(ac, p)
    fcodes = ["OVERDUE", "PROPOSAL_IMMINENT", "HIGH_PROB_PRESALES", "LARGE_STALE", "REV_BEFORE_WIN",
              "WIN_NO_REV", "WIN_FUTURE_REV"]
    code_counts = []
    for c in fcodes:
        n = int(ck["codes"].apply(lambda cs: c in cs).sum()) if not ck.empty else 0
        code_counts.append({"code": c, "label": RULE_MAP[c][2], "action": RULE_MAP[c][3], "count": n})
    # ④ 수주 가능성(진행 중 A/C)
    bins = []
    pb = prog_ac["prob"].apply(prob_bin)
    for lb in [x[0] for x in PROB_BINS] + ["미확인"]:
        g = prog_ac[pb == lb]
        amt = g["contract_amt"]
        valid = g[amt.notna() & g["prob"].notna()]
        bins.append({"bin": lb, "count": int(len(g)), "amount": amount_split(amt),
                     "weighted": float((valid["contract_amt"] * valid["prob"] / 100).sum()) if len(valid) else (None if lb == "미확인" else 0.0)})
    vw = prog_ac[prog_ac["contract_amt"].notna() & prog_ac["prob"].notna()]
    weighted_total = {
        "positive": float((vw.loc[vw["contract_amt"] > 0, "contract_amt"] * vw.loc[vw["contract_amt"] > 0, "prob"] / 100).sum()),
        "negative": float((vw.loc[vw["contract_amt"] < 0, "contract_amt"] * vw.loc[vw["contract_amt"] < 0, "prob"] / 100).sum()),
        "included": int(len(vw)), "excluded": int(len(prog_ac) - len(vw)),
    }
    # ⑤ 종결 결과(A/C, 수주년월 기간 내 현재 종결상태)
    closed = acp[acp["status"].isin(["Win", "Lose", "Drop"])]
    w = int((closed["status"] == "Win").sum())
    lo = int((closed["status"] == "Lose").sum())
    dr = int((closed["status"] == "Drop").sum())
    outcome = {
        "win": w, "lose": lo, "drop": dr,
        "win_amount": fsum(closed.loc[closed["status"] == "Win", "contract_amt"]),
        "lose_amount": fsum(closed.loc[closed["status"] == "Lose", "contract_amt"]),
        "drop_amount": fsum(closed.loc[closed["status"] == "Drop", "contract_amt"]),
        "win_rate": (w / (w + lo)) if (w + lo) > 0 else None,
        "by_type": [],
    }
    for t in ("A", "C"):
        g = closed[closed["acr_type"] == t]
        tw, tl = int((g["status"] == "Win").sum()), int((g["status"] == "Lose").sum())
        outcome["by_type"].append({"type": t, "win": tw, "lose": tl, "drop": int((g["status"] == "Drop").sum()),
                                   "win_rate": tw / (tw + tl) if (tw + tl) else None})
    reasons = {
        "win": reason_table(closed.loc[closed["status"] == "Win", "winloss_reason"]),
        "lose": reason_table(closed.loc[closed["status"] == "Lose", "winloss_reason"]),
        "drop": reason_table(closed.loc[closed["status"] == "Drop", "drop_reason"]),
    }
    return {
        "stage": stage, "stage_r": stage_r, "schedule": sched, "check_counts": code_counts,
        "checks": priority_rows(ac, p, ck, limit=50, codes=fcodes),
        "prob_bins": bins, "weighted_total": weighted_total, "outcome": outcome, "reasons": reasons,
        "basis": {
            "단계 분포": f"A/C, 수주년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)}의 현재 상태 분포(과거 단계 이력·전환율 아님)",
            "금액": "진행 중 Funnel의 계약금액 = 원본 계약기간매출(누락 시 대체하지 않음)",
            "수주 예정": f"진행 중 A/C 전체, 수주년월을 수주 예정월로 사용(업무 가정), 기준월 {R.ym_label(p.base_ym)}; 경과는 기준월보다 이전인 경우만",
            "가중 추정": "유효한 계약기간매출 × 입력 가능성(%) — 통계적으로 검증된 예측이 아닌 입력값 기반 참고치. 원본 '수주가능매출'과 동일시하지 않음",
            "수주율": "승패 결정 건 기준 수주율 = Win/(Win+Lose), Drop 분모 제외, 분모 0이면 산출 불가. 수주년월 기준 현재 종결상태",
        },
    }


# ================================================================ 화면: 재계약·해지


def renewal_view(ds: Dataset, p: Params) -> dict:
    df = filter_df(ds, p)
    if df.empty:
        return {"empty": True}
    rr = df[df["acr_type"] == "R"]
    prog = rr[rr["status"].isin(C.IN_PROGRESS)]
    b = schedule_bucket(prog["win_ym"], p)
    sched = []
    for k in BUCKETS:
        g = prog[b == k]
        sched.append({"bucket": k, "count": int(len(g)), "prev": fsum(g["prev_monthly"]),
                      "new": fsum(g["new_monthly"]), "monthly": fsum(g["monthly"])})
    prog_amt = {"count": int(len(prog)), "prev": fsum(prog["prev_monthly"]), "new": fsum(prog["new_monthly"]),
                "monthly": fsum(prog["monthly"])}
    done = rr[(rr["status"] == "재계약완료") & in_period(rr["win_ym"], p)]
    cls = pd.Series("미확인", index=done.index)
    cls[done["monthly"] > 0] = "증액"
    cls[done["monthly"] == 0] = "동일"
    cls[done["monthly"] < 0] = "감액"
    change = []
    for k in ["증액", "동일", "감액", "미확인"]:
        g = done[cls == k]
        change.append({"class": k, "count": int(len(g)), "prev": fsum(g["prev_monthly"]),
                       "new": fsum(g["new_monthly"]), "monthly": fsum(g["monthly"])})
    mismatch = int(done["issues"].apply(lambda x: "R_AMOUNT_MISMATCH" in x).sum())
    valid = done[(done["prev_monthly"] > 0) & done["new_monthly"].notna()]
    rate = None
    if len(valid) and valid["prev_monthly"].sum() > 0:
        rate = (valid["new_monthly"].sum() - valid["prev_monthly"].sum()) / valid["prev_monthly"].sum()
    churn = rr[(rr["status"] == "해지확정") & in_period(rr["win_ym"], p)]
    key = "am_key" if p.level == "am" else "team"
    by_org = []
    for k, g in churn.groupby(key):
        by_org.append({"key": k, "team": g["team"].iloc[0], "am": g["am"].iloc[0] if key == "am_key" else None,
                       "count": int(len(g)), "prev": fsum(g["prev_monthly"]), "new": fsum(g["new_monthly"]),
                       "monthly": fsum(g["monthly"])})
    by_org.sort(key=lambda x: -x["count"])
    ck = checks_with_rows(rr, p)
    rcodes = ["OVERDUE", "LARGE_RENEWAL", "RENEWAL_DECREASE", "STRATEGY_MISSING", "STALE", "LARGE_STALE",
              "UPDATE_MISSING"]
    code_counts = [{"code": c, "label": RULE_MAP[c][2], "action": RULE_MAP[c][3],
                    "count": int(ck["codes"].apply(lambda cs: c in cs).sum()) if not ck.empty else 0} for c in rcodes]
    return {
        "schedule": sched, "prog_amount": prog_amt,
        "change": change, "mismatch": mismatch,
        "change_rate": {"rate": rate, "included": int(len(valid)), "excluded": int(len(done) - len(valid))},
        "done_count": int(len(done)),
        "churn": {"count": int(len(churn)), "prev": fsum(churn["prev_monthly"]), "new": fsum(churn["new_monthly"]),
                  "monthly": fsum(churn["monthly"]), "by_org": by_org,
                  "reason": reason_table(churn["churn_reason"]), "type": reason_table(churn["churn_type"])},
        "check_counts": code_counts,
        "checks": priority_rows(rr, p, ck, limit=50, codes=rcodes),
        "basis": {
            "재계약 예정": f"R 진행 중 전체, 수주년월을 재계약 예정월로 사용(업무 가정). 기존 계약 만료일은 원본에 없어 표시하지 않음",
            "재계약 완료": f"R 재계약완료, 수주년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)}; 증액/동일/감액은 월매출합계 부호 기준",
            "증감률": "(변경매출 합계 − 기존매출 합계) / 기존매출 합계, 기존매출이 양수이고 변경매출이 있는 동일 대상만(행별 평균 아님)",
            "해지확정": f"R 해지확정, 수주년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)} — 실제 해지·청구중단일이 없어 해지월로 단정하지 않음. 확정 ACR 합계에서 제외",
            "미산출": "대상 집단·결과 정의가 확인되지 않아 재계약 성공률·고객 유지율은 산출하지 않음",
        },
    }


# ================================================================ 화면: 팀·AM


def team_view(ds: Dataset, p: Params) -> dict:
    df = filter_df(ds, p)
    if df.empty:
        return {"empty": True}
    key = "am_key" if p.level == "am" else "team"
    acr = R.compute_acr(df, p.mode, p.ym_from, p.ym_to, p.products, ["A", "C"])
    acr_org = {r["key"]: r for r in (acr["by_am"] if key == "am_key" else acr["by_team"])}
    ck = compute_checks(df, p)
    upd = update_state(df, p)
    prog = df["status"].isin(C.IN_PROGRESS)
    is_r = df["acr_type"] == "R"
    is_ac = df["acr_type"].isin(["A", "C"])
    imm_hi = R.ym_add(p.base_ym, int(p.th["imminent_months"]))
    req_codes = {"YM_MISSING_WIN", "YM_MISSING_REV", "YM_ERROR_WIN", "YM_ERROR_REV", "MONTHLY_MISSING",
                 "TERM_MISSING", "TERM_ZERO", "TERM_NEG", "TERM_FRACTION", "TEAM_MISSING", "AM_MISSING",
                 "NUM_ERROR", "TYPE_UNKNOWN", "STATUS_UNKNOWN"}
    rows = []
    for k, g in df.groupby(key):
        gi = g.index
        pa = g[prog.loc[gi] & is_ac.loc[gi]]
        pr = g[prog.loc[gi] & is_r.loc[gi]]
        win = g[is_ac.loc[gi] & (g["status"] == "Win") & in_period(g["win_ym"], p)]
        rdone = g[is_r.loc[gi] & (g["status"] == "재계약완료") & in_period(g["win_ym"], p)]
        cg = ck.loc[gi]
        o = acr_org.get(k, {})
        rows.append({
            "key": k, "team": g["team"].iloc[0], "am": g["am"].iloc[0] if key == "am_key" else None,
            "prog_ac_count": int(len(pa)), "prog_ac_amount": fsum(pa["contract_amt"]),
            "imminent": int((g["status"].isin(C.IN_PROGRESS) & g["win_ym"].notna() & (g["win_ym"] >= p.base_ym) & (g["win_ym"] <= imm_hi)).sum()),
            "overdue": int((g["status"].isin(C.IN_PROGRESS) & g["win_ym"].notna() & (g["win_ym"] < p.base_ym)).sum()),
            "win_count": int(len(win)), "win_amount": fsum(win["contract_amt"]),
            "acr_ac": o.get("AC", 0.0), "acr_ac_funnels": o.get("funnels", 0),
            "prog_r_count": int(len(pr)), "prog_r_prev": fsum(pr["prev_monthly"]),
            "renewal_decrease_done": int((rdone["monthly"] < 0).sum()),
            "renewal_decrease_expected": int(cg["codes"].apply(lambda cs: "RENEWAL_DECREASE" in cs).sum()),
            "churn": int((is_r.loc[gi] & (g["status"] == "해지확정") & in_period(g["win_ym"], p)).sum()),
            "stale": int((prog.loc[gi] & upd.loc[gi, "stale"].fillna(False)).sum()),
            "update_missing": int((prog.loc[gi] & upd.loc[gi, "missing"]).sum()),
            "missing_info": int(g["issues"].apply(lambda x: bool(req_codes & set(x))).sum()),
            "check_funnels": int((cg["codes"].apply(len) > 0).sum()),
            "check_level1": int((cg["level"] == 1).sum()),
        })
    rows.sort(key=lambda x: -(x["acr_ac"] or 0))
    return {
        "level": "am" if key == "am_key" else "team", "rows": rows,
        "basis": {
            "A/C 누적매출": f"확정 A/C 월매출 증감액 합계 · {R.MODES[p.mode]}, 매출발생년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)}",
            "Win·재계약완료·해지확정": f"수주년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)}",
            "진행 중·임박·경과·미갱신": f"현재 진행 중 전체, 기준일 {p.base_date.isoformat()}, 임박=기준월~+{p.th['imminent_months']}개월, 미갱신 {p.th['stale_days']}일 초과",
            "최근 갱신": "최근영업활동내역 저장일시 기준(실제 고객 접촉일·활동 횟수 아님)",
            "필수정보 누락": "년월·월매출합계·계약기간·조직·유형·상태 누락/오류 또는 숫자 변환 실패",
            "성과등급": "목표·보유고객 규모 자료가 없어 자동 성과등급은 산출하지 않음",
        },
    }


# ================================================================ 화면: 고객·상품·입찰


def insight_view(ds: Dataset, p: Params) -> dict:
    df = filter_df(ds, p)
    if df.empty:
        return {"empty": True}
    acr_all = R.compute_acr(df, "start", p.ym_from, p.ym_to, None, p.types)
    con_rows = set(acr_all["included_rows"])
    # 고객사 표시명 기준
    cust = []
    for name, g in df.groupby(df["customer"].fillna("(고객사 미입력)")):
        inc = g[g.index.isin(con_rows)]
        cust.append({"customer": name, "funnels": int(len(g)),
                     "in_progress": int(g["status"].isin(C.IN_PROGRESS).sum()),
                     "acr": float(inc["monthly"].sum()) if len(inc) else 0.0,
                     "churn": int((g["status"] == "해지확정").sum()),
                     "teams": ", ".join(sorted(g["team"].unique()))})
    cust.sort(key=lambda x: (-x["funnels"], x["customer"]))
    # 상품별(상품1~5 짝 처리, 상품 대응 월매출만 합산, Funnel 금액은 고유 Funnel당 1회)
    names = sorted({n for ns in df["product_names"] for n in ns})
    prod = []
    for nm in names:
        has = df[df["product_names"].apply(lambda ns: nm in ns)]
        a = R.compute_acr(has, "start", p.ym_from, p.ym_to, [nm], p.types)
        pa = has[has["status"].isin(C.IN_PROGRESS) & has["acr_type"].isin(["A", "C"])]
        prod.append({"product": nm, "funnels": int(len(has)),
                     "acr_A": a["totals"]["A"], "acr_C": a["totals"]["C"], "acr_R": a["totals"]["R"],
                     "acr_ACR": a["totals"]["ACR"], "acr_funnels": a["totals"]["funnels"],
                     "prog_ac_count": int(len(pa)), "prog_ac_contract_amt": fsum(pa["contract_amt"])})
    prod.sort(key=lambda x: -x["funnels"])
    diff = df[df["issues"].apply(lambda x: "PRODUCT_SUM_DIFF" in x)]
    # 공공입찰
    bids = df[df["bid_no"].notna()]
    groups = []
    for no, g in bids.groupby("bid_no"):
        groups.append({"bid_no": no, "bid_name": g["bid_name"].dropna().iloc[0] if g["bid_name"].notna().any() else None,
                       "funnels": int(len(g)),
                       "rows": [row_record(r) for _, r in g.iterrows()]})
    groups.sort(key=lambda x: -x["funnels"])
    ac = df[df["acr_type"].isin(["A", "C"]) & in_period(df["win_ym"], p)]
    method = []
    for mth, g in ac.groupby(ac["bid_method"].fillna("(미입력)")):
        method.append({"method": mth, "total": int(len(g)),
                       **{s: int((g["status"] == s).sum()) for s in ["Pre Sales", "제안완료", "Win", "Lose", "Drop"]},
                       "contract_amt": fsum(g["contract_amt"])})
    method.sort(key=lambda x: -x["total"])
    qual = reason_table(ac["qualification"])
    period = df[in_period(df["win_ym"], p)]
    reasons = {
        "win": reason_table(period.loc[period["acr_type"].isin(["A", "C"]) & (period["status"] == "Win"), "winloss_reason"]),
        "lose": reason_table(period.loc[period["acr_type"].isin(["A", "C"]) & (period["status"] == "Lose"), "winloss_reason"]),
        "drop": reason_table(period.loc[period["status"] == "Drop", "drop_reason"]),
        "churn_reason": reason_table(period.loc[period["status"] == "해지확정", "churn_reason"]),
        "churn_type": reason_table(period.loc[period["status"] == "해지확정", "churn_type"]),
    }
    return {
        "customers": cust[:200], "customer_count_display": len(cust),
        "customer_warning": customer_fill_warning(df),
        "products": prod, "product_diff_count": int(len(diff)),
        "bid_groups": groups, "bid_funnels": int(len(bids)),
        "bid_methods": method, "qualification": qual, "reasons": reasons,
        "basis": {
            "고객": "고객사 표시명 기준(마스킹된 이름이 같아도 같은 고객으로 단정하지 않음). 고객 코드가 없어 고유·신규 고객 수와 유지율은 산출하지 않음",
            "고객 ACR": f"매출개시월 기준 확정 ACR(월매출합계), 매출발생년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)}",
            "상품 ACR": "선택 상품 슬롯(상품1~5)의 대응 월매출만 합산(Funnel 전체금액 반복 합산 없음)",
            "상품 계약기간매출": "선택 상품을 보유한 Funnel 전체금액, 고유 Funnel당 1회 반영",
            "R 변경매출": "상품별 배분 근거가 없어 배분하지 않음",
            "입찰": "같은 입찰공고번호의 Funnel을 묶어 보여줄 뿐 중복으로 처리·삭제하지 않음. 입찰 마감일은 원본에 없어 표시하지 않음",
            "입찰방식·사유": f"수주년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)}, 자유 입력 원문 그대로 집계",
        },
    }


# ================================================================ 화면: ACR 매출(Pre-sales)

PS_BINS = [("30%이하", 0, 29.999), ("30%이상", 30, 39.999), ("40%이상", 40, 49.999), ("50%이상", 50, 59.999),
           ("60%이상", 60, 69.999), ("70%이상", 70, 79.999), ("80%이상", 80, 89.999), ("90%이상", 90, 99.999),
           ("100%이상", 100, 100)]
PS_LABELS = [b[0] for b in PS_BINS]


def ps_bin(v) -> str:
    if v is None or pd.isna(v):
        return "미확인"
    for lb, lo, hi in PS_BINS:
        if lo <= v <= hi:
            return lb
    return "미확인"


def _ps_amount(r: pd.Series, sel: set[str]) -> float | None:
    if sel:
        a, _ = R.product_amount(r["products"], sel)
        return a
    v = r["monthly"]
    return None if pd.isna(v) else float(v)


def presales_view(ds: Dataset, p: Params) -> dict:
    """진행 중(Pre Sales·제안완료) Funnel의 예상 ACR 월매출을 유형·수주(재계약) 가능성 구간별로 집계."""
    df = filter_df(ds, p)
    if df.empty:
        return {"empty": True}
    sel = set(p.products)
    prog = df[df["status"].isin(C.IN_PROGRESS)]
    months = R.ym_range(p.ym_from, p.ym_to)
    out = {}
    for t in ("A", "C", "R"):
        g_all = prog[prog["acr_type"] == t]
        g = g_all[in_period(g_all["rev_ym"], p)].copy()
        g["amt"] = [_ps_amount(r, sel) for _, r in g.iterrows()]
        g["band"] = g["prob"].apply(ps_bin)
        bins = []
        for lb in PS_LABELS + ["미확인"]:
            b = g[g["band"] == lb]
            valid = b[b["amt"].notna() & b["prob"].notna()]
            bins.append({
                "band": lb, "count": int(len(b)),
                "presales": int((b["status"] == "Pre Sales").sum()), "proposal": int((b["status"] == "제안완료").sum()),
                "monthly": fsum(b["amt"]), "contract": fsum(b["contract_amt"]),
                "prev": fsum(b["prev_monthly"]), "new": fsum(b["new_monthly"]),
                "weighted": (float((valid["amt"] * valid["prob"] / 100).sum()) if len(valid) else 0.0) if lb != "미확인" else None,
            })
        cc, cm = 0, 0.0
        for rec in reversed(bins[:-1]):  # 100%이상부터 아래로 누적(해당 % 이상 합계)
            cc += rec["count"]
            cm += rec["monthly"] or 0.0
            rec["cum_count"], rec["cum_monthly"] = cc, cm
        bins[-1]["cum_count"], bins[-1]["cum_monthly"] = None, None
        monthly = []
        for ym in months:
            gm = g[g["rev_ym"] == ym]
            by = {lb: float(gm.loc[gm["band"] == lb, "amt"].sum()) for lb in PS_LABELS + ["미확인"]}
            monthly.append({"ym": ym, "label": R.ym_label(ym), "bands": by, "total": float(gm["amt"].sum()),
                            "count": int(len(gm))})
        out[t] = {
            "bins": bins, "monthly": monthly,
            "totals": {"count": int(len(g)), "monthly": fsum(g["amt"]), "contract": fsum(g["contract_amt"]),
                       "prev": fsum(g["prev_monthly"]), "new": fsum(g["new_monthly"]),
                       "weighted": float(sum(rec["weighted"] or 0.0 for rec in bins[:-1]))},
            "excluded": {"rev_ym_missing": int(g_all["rev_ym"].isna().sum()),
                         "out_of_period": int((g_all["rev_ym"].notna() & ~in_period(g_all["rev_ym"], p)).sum())},
        }
    summ = {t: out[t]["totals"] for t in out}
    return {
        "bands": PS_LABELS, "types": out, "summary": summ,
        "basis": {
            "대상": "현재상황 Pre Sales·제안완료(진행 중), 유형별 A/C/R",
            "기간": f"매출발생년월 {R.ym_label(p.ym_from)}~{R.ym_label(p.ym_to)} (매출발생년월 미입력·기간 밖 건은 제외 건수로 표시)",
            "금액": ("선택 상품·카테고리의 대응 월매출(상품1~5)" if p.products else "월매출합계") + " = 수주 시 예상 ACR 월매출 증감액(R은 재계약 증감, 음수 유지)",
            "가능성 구간": "수주(재계약)가능성의 명시적 % 값. 30%이하=0~29%, 30%이상=30~39%, … 90%이상=90~99%, 100%이상=100%. 값이 없거나 %가 아니면 미확인",
            "누적": "‘해당 % 이상 누적’ = 그 구간 이상 모든 구간의 합(예: 70%이상 누적 = 70~100%)",
            "가중": "월매출 × 가능성(%) — 입력 가능성 기반 참고치이며 통계적 예측이 아님",
            "주의": "확정 ACR(누적매출)과 합산하지 않음. 진행 중 기회의 현재 입력값 기준",
        },
    }


# ================================================================ 상세 목록(드릴다운)

DRILL_KEYS = {"scope", "status", "acr_type", "bucket", "imminent", "prob_band", "code", "team", "am_key", "ym", "product",
              "customer", "bid_no", "prob_bin", "period", "change", "level"}


def drill_rows(ds: Dataset, p: Params, drill: dict | None) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, str]:
    """(대상행, 확인사유, ACR basis, 설명). scope:
    all(기본, 중복·누락 포함) / acr(확정 ACR 포함 행) / acr_excluded / checks / in_progress / quality."""
    drill = {k: v for k, v in (drill or {}).items() if k in DRILL_KEYS and v not in (None, "", [])}
    scope = drill.get("scope", "all")
    df = filter_df(ds, p, include_excluded=(scope in ("all", "quality")))
    desc = []
    if df.empty:
        return df, pd.DataFrame(), pd.DataFrame(), "자료 없음"
    basis = R.acr_basis(df, p.mode, p.products)
    ck = compute_checks(df, p)
    m = pd.Series(True, index=df.index)
    if scope == "acr":
        con, _ = R.contributions(df, p.mode, p.ym_from, p.ym_to, p.products)
        con = con[con["acr_type"].isin(p.types)]
        if drill.get("ym"):
            con = con[con["ym"] == int(drill["ym"])]
            desc.append(f"{R.ym_label(int(drill['ym']))} 반영")
        m &= df.index.isin(con["row"].unique())
        desc.append(f"확정 ACR 포함({R.MODES[p.mode]})")
    elif scope == "acr_excluded":
        m &= basis["confirmed"] & basis["excl_reason"].notna()
        desc.append("확정 ACR 조건이나 계산 제외")
    elif scope == "checks":
        m &= ck["codes"].apply(len) > 0
        desc.append("우선 확인 대상")
    elif scope == "in_progress":
        m &= df["status"].isin(C.IN_PROGRESS)
        desc.append("진행 중")
    elif scope == "quality":
        m &= df["issues"].apply(lambda x: len([i for i in x if i != "OUT_OF_SCOPE_HQ"]) > 0)
        desc.append("데이터 품질 확인 행")
    if drill.get("status"):
        st = _list(drill["status"])
        m &= df["status"].isin(st)
        desc.append("상태=" + "/".join(st))
    if drill.get("acr_type"):
        ts = _list(drill["acr_type"])
        m &= df["acr_type"].isin(ts)
        desc.append("유형=" + "/".join(ts))
    if drill.get("bucket"):
        bs = _list(drill["bucket"])
        m &= schedule_bucket(df["win_ym"], p).isin(bs)
        desc.append("일정=" + "/".join(bs))
    if drill.get("imminent"):
        hi = R.ym_add(p.base_ym, int(p.th["imminent_months"]))
        m &= df["status"].isin(C.IN_PROGRESS) & df["win_ym"].notna() & (df["win_ym"] >= p.base_ym) & (df["win_ym"] <= hi)
        m = m.fillna(False).astype(bool)
        desc.append(f"예정 임박(기준월~+{p.th['imminent_months']}개월)")
    if drill.get("code"):
        cs = _list(drill["code"])
        m &= ck["codes"].apply(lambda x: bool(set(x) & set(cs)))
        desc.append("사유=" + "/".join(RULE_MAP[c][2] if c in RULE_MAP else c for c in cs))
    if drill.get("level"):
        m &= ck["level"] == int(drill["level"])
    if drill.get("team"):
        m &= df["team"] == drill["team"]
        desc.append(f"팀={drill['team']}")
    if drill.get("am_key"):
        m &= df["am_key"] == drill["am_key"]
        desc.append(f"AM={drill['am_key'].split('|')[-1]}")
    if drill.get("product"):
        m &= df["product_names"].apply(lambda ns: drill["product"] in ns)
        desc.append(f"상품={drill['product']}")
    if drill.get("customer"):
        m &= df["customer"].fillna("(고객사 미입력)") == drill["customer"]
        desc.append(f"고객사(표시명)={drill['customer']}")
    if drill.get("bid_no"):
        m &= df["bid_no"] == drill["bid_no"]
        desc.append(f"입찰공고번호={drill['bid_no']}")
    if drill.get("prob_band"):
        m &= df["prob"].apply(ps_bin) == drill["prob_band"]
        desc.append(f"가능성 구간={drill['prob_band']}")
    if drill.get("prob_bin"):
        m &= df["prob"].apply(prob_bin) == drill["prob_bin"]
        desc.append(f"가능성={drill['prob_bin']}")
    if drill.get("period") in ("win_ym", "rev_ym"):
        m &= in_period(df[drill["period"]], p)
        desc.append(("수주년월" if drill["period"] == "win_ym" else "매출발생년월") + " 기간 내")
    if drill.get("change"):
        ch = drill["change"]
        mm = df["monthly"]
        m &= {"증액": mm > 0, "동일": mm == 0, "감액": mm < 0, "미확인": mm.isna()}.get(ch, True)
        desc.append(f"증감={ch}")
    sel = df[m]
    return sel, ck.loc[sel.index], basis.loc[sel.index], " · ".join(desc) or "전체"


SORTABLE = {"funnel_id", "customer", "team", "am", "acr_type", "status", "win_ym", "rev_ym", "monthly",
            "contract_amt", "prev_monthly", "new_monthly", "updated_at", "level", "row"}


def detail_view(ds: Dataset, p: Params, drill: dict | None, page: int = 1, size: int = 50,
                sort: str = "row", desc_order: bool = False, q: str = "") -> dict:
    sel, ck, basis, desc = drill_rows(ds, p, drill)
    if sel.empty:
        return {"rows": [], "total": 0, "page": 1, "pages": 0, "desc": desc}
    if q:
        ql = q.lower()
        hay = sel["customer"].fillna("") + " " + sel["funnel_id"].fillna("") + " " + sel["am"].fillna("") + " " + sel["team"].fillna("")
        mm = hay.str.lower().str.contains(ql, regex=False)
        sel, ck, basis = sel[mm], ck[mm], basis[mm]
    tmp = sel.copy()
    tmp["level"] = ck["level"]
    sort = sort if sort in SORTABLE else "row"
    tmp = tmp.sort_values(sort, ascending=not desc_order, na_position="last", kind="mergesort")
    total = len(tmp)
    size = max(10, min(int(size), 500))
    pages = max(1, math.ceil(total / size))
    page = max(1, min(int(page), pages))
    part = tmp.iloc[(page - 1) * size: page * size]
    rows = [row_record(sel.loc[i], ck.loc[i].to_dict(),
                       {"included": bool(basis.loc[i, "included"]), "reason": basis.loc[i, "excl_reason"]})
            for i in part.index]
    return {"rows": rows, "total": int(total), "page": page, "pages": pages, "size": size, "desc": desc}


def quality_view(ds: Dataset, p: Params) -> dict:
    if ds.empty:
        return {"empty": True, "meta": ds.meta}
    df_all = ds.df
    scope = df_all[df_all["in_scope"]]
    agg = scope[~scope["agg_excluded"]]
    metrics = []
    for mode in ("start", "term"):
        b = R.acr_basis(agg, mode)
        conf = b[b["confirmed"]]
        metrics.append({"metric": R.MODES[mode], "confirmed_rows": int(len(conf)),
                        "included": int(conf["included"].sum()),
                        "excluded": {k: int(v) for k, v in conf["excl_reason"].value_counts().items()}})
    upd = update_state(scope, p)
    return {
        "meta": ds.meta, "quality": ds.quality,
        "summary": {
            "source_rows": int(len(df_all)), "in_scope_rows": int(len(scope)),
            "agg_rows": int(len(agg)), "agg_excluded_rows": int(scope["agg_excluded"].sum()),
            "future_update_rows": int(upd["future"].fillna(False).sum()),
            "missing_update_rows": int(upd["missing"].sum()),
        },
        "metrics": metrics,
    }


def raw_row(ds: Dataset, row: int) -> dict | None:
    return ds.by_row.get(int(row))
