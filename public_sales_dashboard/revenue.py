"""ACR 수주 계산 — 모든 카드·차트·표·다운로드가 이 함수를 공통으로 사용한다.

지표 정의
① 매출개시월 기준 ACR 월매출 증감액 (mode='start', 신규 증분만)
   적격 Funnel의 월매출합계를 매출발생년월에 한 번만 배치한다.
② 계약기간 반영 월별 매출 증감 추정 (mode='term', 기본)
   적격 Funnel의 월매출합계를 매출발생년월(포함)부터 계약기간(월) 동안 매월 반영한다.
   계약기간 종료 다음 달부터 제외, 일할 계산 없음. 실제 청구 실적이 아닌 추정값이다.

ACR 확정 조건: A=Acq.+Win, C=Cul.+Win, R=Ret.+재계약완료.
R은 월매출합계(재계약 증감액)를 사용하며 음수를 유지한다. 재계약 후 월매출(변경매출)은 별도 지표.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config as C

MODES = {
    "start": "매출개시월 기준 ACR 월매출 증감액",
    "term": "계약기간 반영 월별 매출 증감 추정",
}
SERIES = ["A", "C", "R", "AC", "ACR"]
SERIES_LABEL = {"A": "A", "C": "C", "R": "R", "AC": "A+C", "ACR": "A+C+R"}

EXCL_NOT_CONFIRMED = "확정 ACR 조건 아님"
EXCL_AGG = "Funnel번호 중복·누락(검토 전 제외)"
EXCL_REV_YM = "매출발생년월 누락·오류"
EXCL_MONTHLY = "월매출합계 누락·숫자 오류"
EXCL_TERM = "계약기간 누락·0·음수·소수"
EXCL_PRODUCT_AMT = "선택 상품 월매출 누락"


# ---------------------------------------------------------------- 년월 유틸

def ym_add(ym: int, k: int) -> int:
    y, m = divmod(int(ym), 100)
    t = y * 12 + (m - 1) + k
    return (t // 12) * 100 + (t % 12) + 1


def ym_range(a: int, b: int) -> list[int]:
    out, cur = [], int(a)
    while cur <= int(b):
        out.append(cur)
        cur = ym_add(cur, 1)
    return out


def ym_diff(a: int, b: int) -> int:
    """b - a (개월)."""
    return (int(b) // 100 - int(a) // 100) * 12 + (int(b) % 100 - int(a) % 100)


def ym_label(ym) -> str:
    if ym is None or pd.isna(ym):
        return ""
    ym = int(ym)
    return f"{ym // 100}-{ym % 100:02d}"


# ---------------------------------------------------------------- 상품 금액

def product_amount(products: list[dict], selected: set[str]) -> tuple[float | None, bool]:
    """선택 상품의 대응 월매출 합계. (금액, 선택상품 보유 여부). 같은 Funnel 안에서도 슬롯별 1회만 합산."""
    hit = [p for p in products if p.get("product") in selected]
    if not hit:
        return None, False
    vals = [p["amount"] for p in hit if p.get("amount") is not None]
    if not vals:
        return None, True
    return float(sum(vals)), True


def is_confirmed(df: pd.DataFrame) -> pd.Series:
    want = df["acr_type"].map(C.ACR_CONFIRMED_STATUS)
    return df["acr_type"].isin(list(C.ACR_CONFIRMED_STATUS)) & (df["status"] == want)


def acr_basis(df: pd.DataFrame, mode: str, products: list[str] | None = None) -> pd.DataFrame:
    """행별 ACR 포함 여부·제외 사유·적용 금액을 계산(기간 적용 전)."""
    out = pd.DataFrame(index=df.index)
    sel = set(products or [])
    if sel:
        pa = df["products"].apply(lambda ps: product_amount(ps, sel))
        amount = pa.apply(lambda t: t[0])
        has_prod = pa.apply(lambda t: t[1])
    else:
        amount = df["monthly"]
        has_prod = pd.Series(True, index=df.index)
    out["amount"] = pd.to_numeric(amount, errors="coerce").astype(float)
    out["has_product"] = has_prod
    confirmed = is_confirmed(df)
    reason = pd.Series(None, index=df.index, dtype=object)
    reason[~confirmed] = EXCL_NOT_CONFIRMED
    m = confirmed & df["agg_excluded"]
    reason[m & reason.isna()] = EXCL_AGG
    reason[confirmed & df["rev_ym"].isna() & reason.isna()] = EXCL_REV_YM
    if sel:
        reason[confirmed & has_prod & out["amount"].isna() & reason.isna()] = EXCL_PRODUCT_AMT
    else:
        reason[confirmed & out["amount"].isna() & reason.isna()] = EXCL_MONTHLY
    if mode == "term":
        reason[confirmed & df["term"].isna() & reason.isna()] = EXCL_TERM
    out["confirmed"] = confirmed
    out["excl_reason"] = reason
    out["included"] = reason.isna() & has_prod
    return out


def contributions(df: pd.DataFrame, mode: str, ym_from: int, ym_to: int,
                  products: list[str] | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(월별 기여 행, 행별 basis). 기여 행: row·funnel_id·team·am_key·acr_type·ym·amount."""
    basis = acr_basis(df, mode, products)
    cols = ["row", "funnel_id", "team", "am_key", "am", "acr_type", "ym", "amount"]
    inc = df[basis["included"]]
    if inc.empty:
        return pd.DataFrame(columns=cols), basis
    start = inc["rev_ym"].astype(int)
    base = pd.DataFrame({
        "row": inc.index, "funnel_id": inc["funnel_id"].values, "team": inc["team"].values,
        "am_key": inc["am_key"].values, "am": inc["am"].values, "acr_type": inc["acr_type"].values,
        "amount": basis.loc[inc.index, "amount"].astype(float).values,
    })
    if mode == "term":
        # 시작월 포함 계약기간(월)만큼 반복, 종료 다음 달부터 제외(일할 없음)
        terms = inc["term"].astype(int).values
        rep = base.loc[base.index.repeat(terms)].reset_index(drop=True)
        offs = np.concatenate([np.arange(t) for t in terms]) if len(terms) else np.array([], dtype=int)
        st = np.repeat(start.values, terms)
        tot = (st // 100) * 12 + (st % 100 - 1) + offs
        rep["ym"] = (tot // 12) * 100 + (tot % 12) + 1
        con = rep
    else:
        con = base.assign(ym=start.values)
    con = con[(con["ym"] >= ym_from) & (con["ym"] <= ym_to)][cols].reset_index(drop=True)
    return con, basis


def churn_contrib(df: pd.DataFrame, mode: str, ym_from: int, ym_to: int,
                  products: list[str] | None = None) -> dict:
    """해지확정 감소액(월매출합계 = −기존매출)을 R과 같은 규칙(매출발생년월·계약기간·상품)으로 반영. R 합계와 별도."""
    sub = df[df["status"] == "해지확정"].copy()
    if sub.empty:
        return {"amount": 0.0, "funnels": 0, "excluded": {}}
    sub["status"] = sub["acr_type"].map(C.ACR_CONFIRMED_STATUS)  # 계산 규칙 재사용을 위한 임시 치환(원본 불변)
    con, basis = contributions(sub, mode, ym_from, ym_to, products)
    ex = basis.loc[basis["excl_reason"].notna(), "excl_reason"]
    ex = ex.replace({EXCL_NOT_CONFIRMED: "ACR유형 미입력·비대상"})
    return {"amount": float(con["amount"].sum()) if len(con) else 0.0,
            "funnels": int(con["row"].nunique()) if len(con) else 0,
            "excluded": {str(k): int(v) for k, v in ex.value_counts().sort_index().items()}}


def _type_sums(g: pd.DataFrame) -> dict:
    s = g.groupby("acr_type")["amount"].sum() if len(g) else pd.Series(dtype=float)
    a, c, r = float(s.get("A", 0.0)), float(s.get("C", 0.0)), float(s.get("R", 0.0))
    return {"A": a, "C": c, "R": r, "AC": a + c, "ACR": a + c + r}


def compute_acr(df: pd.DataFrame, mode: str, ym_from: int, ym_to: int,
                products: list[str] | None = None, types: list[str] | None = None) -> dict:
    mode = mode if mode in MODES else "start"
    types = [t for t in (types or ["A", "C", "R"]) if t in ("A", "C", "R")] or ["A", "C", "R"]
    con, basis = contributions(df, mode, ym_from, ym_to, products)
    con = con[con["acr_type"].isin(types)]
    months = ym_range(ym_from, ym_to)

    monthly_rows = []
    cum = {k: 0.0 for k in SERIES}
    for ym in months:
        g = con[con["ym"] == ym]
        sums = _type_sums(g)
        for k in SERIES:
            cum[k] += sums[k]
        monthly_rows.append({
            "ym": ym, "label": ym_label(ym), **sums,
            "funnels": int(g["row"].nunique()),
            "cum": {k: cum[k] for k in SERIES},
        })
    totals = _type_sums(con)
    totals["funnels"] = int(con["row"].nunique())
    for t in ("A", "C", "R"):
        totals[f"funnels_{t}"] = int(con.loc[con["acr_type"] == t, "row"].nunique())

    def org_table(key: str, label_cols: list[str]) -> list[dict]:
        rows = []
        if con.empty:
            return rows
        for k, g in con.groupby(key):
            sums = _type_sums(g)
            rneg = g[(g["acr_type"] == "R") & (g["amount"] < 0)]
            first = g.iloc[0]
            rows.append({
                "key": k, **{c: first[c] for c in label_cols}, **sums,
                "funnels": int(g["row"].nunique()),
                "r_neg_count": int(rneg["row"].nunique()),
                "r_neg_amount": float(rneg["amount"].sum()),
            })
        rows.sort(key=lambda x: -x["ACR"])
        return rows

    confirmed = basis[basis["confirmed"]]
    excl = confirmed[confirmed["excl_reason"].notna()]
    excl_counts = excl["excl_reason"].value_counts().to_dict()
    return {
        "mode": mode,
        "mode_label": MODES[mode],
        "range": [ym_from, ym_to],
        "types": types,
        "monthly": monthly_rows,
        "totals": totals,
        "by_team": org_table("team", ["team"]),
        "by_am": org_table("am_key", ["team", "am"]),
        "excluded": {k: int(v) for k, v in excl_counts.items()},
        "included_rows": sorted(int(x) for x in con["row"].unique()),
        "confirmed_rows": int(len(confirmed)),
    }
