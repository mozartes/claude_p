"""ACR 계산 검증(합성 데이터)."""
import pytest

import revenue as R
from conftest import row


def acr(ds, mode="start", f=202601, t=202612, products=None, types=None):
    df = ds.df[~ds.df["agg_excluded"]]
    return R.compute_acr(df, mode, f, t, products, types)


def test_confirmed_conditions(make_ds):
    ds = make_ds([
        row(type="Acq.", status="Win", monthly=10, rev=202603),          # 포함
        row(type="Acq.", status="Pre Sales", monthly=99, rev=202603),    # 제외
        row(type="Cul.", status="Win", monthly=5, rev=202603),           # 포함
        row(type="Ret.", status="재계약완료", monthly=-2, prev=100, new=98, rev=202603),  # 포함
        row(type="Ret.", status="Win", monthly=77, rev=202603),          # 제외(R은 재계약완료만)
        row(type="Ret.", status="해지확정", monthly=-50, prev=50, new=0, rev=202603),  # 제외
        row(type="Acq.", status="제안완료", monthly=9, rev=202603),
        row(type="Cul.", status="Lose", monthly=9, rev=202603),
        row(type="Cul.", status="Drop", monthly=9, rev=202603),
    ])
    r = acr(ds)
    t = r["totals"]
    assert t["A"] == 10 and t["C"] == 5 and t["R"] == -2
    assert t["AC"] == 15 and t["ACR"] == 13
    assert t["funnels"] == 3


def test_start_month_not_win_month(make_ds):
    # 수주월 10월, 매출발생월 12월 → 10~11월 미반영
    ds = make_ds([row(win=202610, rev=202612, monthly=10, term=3)])
    m = {x["ym"]: x["ACR"] for x in acr(ds)["monthly"]}
    assert m[202610] == 0 and m[202611] == 0 and m[202612] == 10
    mt = {x["ym"]: x["ACR"] for x in acr(ds, "term")["monthly"]}
    assert mt[202610] == 0 and mt[202611] == 0 and mt[202612] == 10


def test_term_spans_year(make_ds):
    # 12월 시작·3개월 → 12월, 다음 해 1~2월, 3월 제외
    ds = make_ds([row(rev=202612, monthly=7, term=3)])
    m = {x["ym"]: x["ACR"] for x in acr(ds, "term", 202612, 202704)["monthly"]}
    assert m == {202612: 7, 202701: 7, 202702: 7, 202703: 0, 202704: 0}


def test_prior_year_contract_in_period(make_ds):
    # 전년도 2025-11 시작 6개월 → 2026-01~04 반영
    ds = make_ds([row(win=202510, rev=202511, monthly=4, term=6)])
    m = {x["ym"]: x["ACR"] for x in acr(ds, "term")["monthly"]}
    assert [m[k] for k in (202601, 202602, 202603, 202604, 202605)] == [4, 4, 4, 4, 0]
    # 매출개시월 기준에서는 조회기간 밖이므로 0
    assert acr(ds)["totals"]["ACR"] == 0
    r = acr(ds, "term")
    assert r["totals"]["funnels"] == 1  # 고유 Funnel(반복 횟수 아님)


def test_r_negative_kept_and_new_monthly_separate(make_ds):
    ds = make_ds([row(type="Ret.", status="재계약완료", prev=100, new=90, monthly=-10, rev=202605)])
    r = acr(ds)
    assert r["totals"]["R"] == -10
    df = ds.df
    assert float(df.iloc[0]["new_monthly"]) == 90  # 재계약 후 월매출은 별도 지표
    assert r["by_team"][0]["r_neg_count"] == 1 and r["by_team"][0]["r_neg_amount"] == -10


def test_zero_and_negative_kept(make_ds):
    ds = make_ds([row(monthly=0, rev=202601), row(type="Cul.", monthly=-3, rev=202601)])
    r = acr(ds)
    assert r["totals"]["A"] == 0 and r["totals"]["C"] == -3 and r["totals"]["funnels"] == 2


def test_example_calc(make_ds):
    # A=10, C=5, R=-2 같은 월 시작, 계약 3개월
    ds = make_ds([
        row(type="Acq.", monthly=10, rev=202605, term=3),
        row(type="Cul.", monthly=5, rev=202605, term=3),
        row(type="Ret.", status="재계약완료", monthly=-2, prev=10, new=8, rev=202605, term=3),
    ])
    s = acr(ds)
    assert s["totals"]["AC"] == 15 and s["totals"]["ACR"] == 13
    t = acr(ds, "term")
    m = {x["ym"]: x["ACR"] for x in t["monthly"]}
    assert m[202605] == m[202606] == m[202607] == 13 and m[202608] == 0
    assert t["totals"]["ACR"] == 39
    assert sum(x["ACR"] for x in t["monthly"]) == pytest.approx(39)


def test_org_sums_equal_total(make_ds):
    rows = []
    for i, (tm, am) in enumerate([("팀1", "가"), ("팀1", "나"), ("팀2", "가"), ("팀2", "다")]):
        rows.append(row(team=tm, am=am, type="Acq.", monthly=1.5 + i, rev=202602 + i, term=5))
        rows.append(row(team=tm, am=am, type="Ret.", status="재계약완료", monthly=-0.7 * i, rev=202603, term=4))
    ds = make_ds(rows)
    for mode in ("start", "term"):
        r = acr(ds, mode)
        for k in ("A", "C", "R", "AC", "ACR"):
            assert sum(x[k] for x in r["by_team"]) == pytest.approx(r["totals"][k])
            assert sum(x[k] for x in r["by_am"]) == pytest.approx(r["totals"][k])
            assert sum(m[k] for m in r["monthly"]) == pytest.approx(r["totals"][k])
        assert len(r["by_am"]) == 4  # 같은 AM 이름(가)이 두 팀에 있으면 팀+AM으로 구분


def test_invalid_term_excluded_only_in_term_mode(make_ds):
    ds = make_ds([row(monthly=3, rev=202604, term=0), row(monthly=2, rev=202604, term=None),
                  row(monthly=1, rev=202604, term=2.5), row(monthly=4, rev=202604, term=-1)])
    s = acr(ds)
    assert s["totals"]["ACR"] == 10 and not s["excluded"]
    t = acr(ds, "term")
    assert t["totals"]["ACR"] == 0
    assert t["excluded"][R.EXCL_TERM] == 4


def test_missing_vs_zero_monthly(make_ds):
    ds = make_ds([row(monthly=None, rev=202604, 상품1="국내전용", 월매출1=None), row(monthly=0, rev=202604)])
    r = acr(ds)
    assert r["totals"]["funnels"] == 1
    assert r["excluded"][R.EXCL_MONTHLY] == 1


def test_product_amount_no_double_count(make_ds):
    # 한 Funnel에 상품 2개 → 선택 상품의 대응 월매출만 합산, 상품 미선택 시 월매출합계
    ds = make_ds([row(monthly=10, rev=202603, 상품1="국내전용", 월매출1=6, 상품2="인터넷", 월매출2=4),
                  row(monthly=3, rev=202603, 상품1="인터넷", 월매출1=3)])
    assert acr(ds)["totals"]["ACR"] == 13
    assert acr(ds, products=["국내전용"])["totals"]["ACR"] == 6
    assert acr(ds, products=["인터넷"])["totals"]["ACR"] == 7
    both = acr(ds, products=["국내전용", "인터넷"])
    assert both["totals"]["ACR"] == 13 and both["totals"]["funnels"] == 2


def test_ym_helpers():
    assert R.ym_add(202612, 1) == 202701 and R.ym_add(202601, -1) == 202512
    assert R.ym_range(202611, 202702) == [202611, 202612, 202701, 202702]
    assert R.ym_diff(202611, 202702) == 3
