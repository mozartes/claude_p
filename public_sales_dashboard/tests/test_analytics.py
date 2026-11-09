"""영업관리 규칙 검증(합성 데이터)."""
import analytics as A
from conftest import row


def codes_of(ds, p, fid):
    df = A.filter_df(ds, p)
    ck = A.compute_checks(df, p)
    i = df.index[df["funnel_id"] == fid][0]
    return ck.loc[i, "codes"]


def test_overdue_month_boundary(make_ds, params):
    ds = make_ds([
        row(fid="F_PREV", status="Pre Sales", win=202610),   # 기준월(11월) 이전 → 경과
        row(fid="F_SAME", status="Pre Sales", win=202611),   # 같은 달 → 경과 아님
        row(fid="F_NEXT", status="제안완료", win=202612),
        row(fid="F_NONE", status="Pre Sales", win=None),
    ])
    p = params()
    assert "OVERDUE" in codes_of(ds, p, "F_PREV")
    assert "OVERDUE" not in codes_of(ds, p, "F_SAME")
    df = A.filter_df(ds, p)
    b = dict(zip(df["funnel_id"], A.schedule_bucket(df["win_ym"], p)))
    assert b == {"F_PREV": "예정월 경과", "F_SAME": "이번 달", "F_NEXT": "다음 달", "F_NONE": "예정월 미입력"}
    assert "PROPOSAL_IMMINENT" in codes_of(ds, p, "F_NEXT")
    # 기준일을 11월 30일로 바꿔도 같은 달이면 경과 아님
    assert "OVERDUE" not in codes_of(ds, params(base_date="2026-11-30"), "F_SAME")


def test_stale_boundary_missing_future(make_ds, params):
    ds = make_ds([
        row(fid="D30", status="Pre Sales", win=202612, upd="2026-10-02"),  # 30일 → 미갱신 아님
        row(fid="D31", status="Pre Sales", win=202612, upd="2026-10-01"),  # 31일 → 미갱신
        row(fid="DNONE", status="Pre Sales", win=202612, upd=None),
        row(fid="DFUT", status="Pre Sales", win=202612, upd="2026-11-05"),
        row(fid="DWIN", status="Win", upd="2020-01-01"),                   # 진행 중 아님 → 미갱신 대상 아님
    ])
    p = params()
    assert "STALE" not in codes_of(ds, p, "D30")
    assert "STALE" in codes_of(ds, p, "D31")
    c = codes_of(ds, p, "DNONE")
    assert "UPDATE_MISSING" in c and "STALE" not in c
    c = codes_of(ds, p, "DFUT")
    assert "UPDATE_FUTURE" in c and "STALE" not in c
    assert "STALE" not in codes_of(ds, p, "DWIN")
    # 기준값 변경
    assert "STALE" in codes_of(ds, params(th={"stale_days": 29}), "D30")


def test_renewal_change_classes_and_rate(make_ds, params):
    ds = make_ds([
        row(type="Ret.", status="재계약완료", prev=100, new=110, monthly=10, win=202605),
        row(type="Ret.", status="재계약완료", prev=50, new=50, monthly=0, win=202605),
        row(type="Ret.", status="재계약완료", prev=100, new=90, monthly=-10, win=202605),
        row(type="Ret.", status="재계약완료", prev=0, new=5, monthly=5, win=202605),        # 증감률 제외(기존 0)
        row(type="Ret.", status="재계약완료", prev=20, new=15, monthly=-3, win=202605),     # 금액 불일치
        row(type="Ret.", status="해지확정", prev=30, new=0, monthly=-30, win=202605),
    ])
    r = A.renewal_view(ds, params())
    ch = {c["class"]: c for c in r["change"]}
    assert ch["증액"]["count"] == 2 and ch["동일"]["count"] == 1 and ch["감액"]["count"] == 2
    assert ch["감액"]["monthly"] == -13
    assert r["mismatch"] == 1
    cr = r["change_rate"]
    assert cr["included"] == 4 and cr["excluded"] == 1
    assert abs(cr["rate"] - ((110 + 50 + 90 + 15) - (100 + 50 + 100 + 20)) / 270) < 1e-12
    assert r["churn"]["count"] == 1 and r["churn"]["prev"] == 30


def test_churn_separate_from_acr(make_ds, params):
    ds = make_ds([row(type="Ret.", status="해지확정", prev=30, new=0, monthly=-30, rev=202605, win=202605),
                  row(type="Acq.", monthly=5, rev=202605)])
    ov = A.overview_view(ds, params())
    assert ov["kpi"]["acr"]["ACR"] == 5 and ov["kpi"]["churn_count"] == 1


def test_win_rate_drop_excluded_and_zero_denominator(make_ds, params):
    ds = make_ds([row(status="Win"), row(status="Win"), row(status="Lose"), row(status="Drop"), row(status="Drop")])
    o = A.funnel_view(ds, params())["outcome"]
    assert o["win"] == 2 and o["lose"] == 1 and o["drop"] == 2
    assert abs(o["win_rate"] - 2 / 3) < 1e-12
    ds2 = make_ds([row(status="Drop"), row(status="Pre Sales")])
    assert A.funnel_view(ds2, params())["outcome"]["win_rate"] is None


def test_multiple_reasons_one_row(make_ds, params):
    ds = make_ds([row(fid="MULTI", type="Ret.", status="Pre Sales", win=202609, prev=100, new=80, monthly=-20,
                      upd="2026-01-01", strategy="N")])
    p = params()
    rows = A.priority_rows(A.filter_df(ds, p), p)
    assert len(rows) == 1
    r = rows[0]
    assert set(r["check_codes"]) >= {"OVERDUE", "RENEWAL_DECREASE", "STRATEGY_MISSING", "STALE", "LARGE_RENEWAL", "LARGE_STALE"}
    assert r["level"] == 1 and r["check_amount_basis"] == "기존 월매출"
    assert A.overview_view(ds, p)["kpi"]["check_count"] == 1


def test_weighted_estimate_and_prob(make_ds, params):
    ds = make_ds([
        row(status="Pre Sales", contract=100, prob="50%(중중)", win=202612),
        row(status="Pre Sales", contract=-10, prob="30%(하상)", win=202612),
        row(status="Pre Sales", contract=40, prob="알수없음", win=202612),
        row(status="Pre Sales", contract=None, prob="90%(상상)", win=202612),
    ])
    f = A.funnel_view(ds, params())
    w = f["weighted_total"]
    assert w["positive"] == 50 and w["negative"] == -3 and w["included"] == 2 and w["excluded"] == 2
    bins = {b["bin"]: b for b in f["prob_bins"]}
    assert bins["미확인"]["count"] == 1 and bins["90~100%"]["amount"]["missing_count"] == 1


def test_amount_missing_vs_zero(make_ds, params):
    ds = make_ds([row(status="Pre Sales", contract=None, win=202612)])
    s = A.funnel_view(ds, params())["schedule"]
    nxt = [x for x in s if x["bucket"] == "다음 달"][0]
    assert nxt["count"] == 1 and nxt["amount"]["total"] is None  # 자료 없음(0 아님)
    ds2 = make_ds([row(status="Pre Sales", contract=0, win=202612)])
    nxt2 = [x for x in A.funnel_view(ds2, params())["schedule"] if x["bucket"] == "다음 달"][0]
    assert nxt2["amount"]["total"] == 0


def test_product_insight_no_repeat(make_ds, params):
    ds = make_ds([row(status="Pre Sales", contract=100, win=202612, monthly=10,
                      상품1="국내전용", 월매출1=6, 상품2="인터넷", 월매출2=4)])
    prods = {p["product"]: p for p in A.insight_view(ds, params())["products"]}
    assert prods["국내전용"]["prog_ac_contract_amt"] == 100 and prods["인터넷"]["prog_ac_contract_amt"] == 100
    assert prods["국내전용"]["prog_ac_count"] == 1


def test_customer_masking_basis(make_ds, params):
    ds = make_ds([row(cust="한국****"), row(cust="한국****", team="팀2")])
    ins = A.insight_view(ds, params())
    assert "표시명 기준" in ins["basis"]["고객"]
    assert ins["customers"][0]["funnels"] == 2


def test_duplicates_excluded_and_listed(make_ds, params):
    ds = make_ds([row(fid="DUP", monthly=5, rev=202603), row(fid="DUP", monthly=7, rev=202603),
                  row(fid="OK", monthly=1, rev=202603), row(fid=None, monthly=100, rev=202603)])
    assert ds.quality["dup_group_count"] == 1 and ds.quality["agg_excluded_rows"] == 3
    p = params()
    assert A.acr_view(ds, p)["totals"]["ACR"] == 1
    d = A.detail_view(ds, p, {"scope": "all"})
    assert d["total"] == 4  # 목록에는 표시(조용히 누락하지 않음)
    assert sum(1 for r in d["rows"] if r["agg_excluded"]) == 3


def test_same_bid_not_duplicate(make_ds, params):
    ds = make_ds([row(입찰공고번호="R26BK1", monthly=1, rev=202603), row(입찰공고번호="R26BK1", monthly=2, rev=202603)])
    assert ds.quality["dup_group_count"] == 0
    ins = A.insight_view(ds, params())
    assert ins["bid_groups"][0]["funnels"] == 2
    assert A.acr_view(ds, params())["totals"]["ACR"] == 3


def test_empty_filter_result(make_ds, params):
    ds = make_ds([row()])
    p = params(search="없는고객")
    assert A.overview_view(ds, p) == {"empty": True}
    assert A.detail_view(ds, p, {})["total"] == 0


def test_out_of_scope_hq(make_ds, params):
    ds = make_ds([row(hq="기업고객담당", monthly=50, rev=202603), row(monthly=1, rev=202603)])
    assert A.acr_view(ds, params())["totals"]["ACR"] == 1


def test_rev_before_win_flagged_not_fixed(make_ds, params):
    ds = make_ds([row(fid="ODD", win=202608, rev=202606)])
    assert "REV_BEFORE_WIN" in codes_of(ds, params(), "ODD")
    assert int(ds.df.iloc[0]["rev_ym"]) == 202606  # 원본값 유지


def test_drill_matches_card(make_ds, params):
    ds = make_ds([row(monthly=3, rev=202603), row(type="Cul.", monthly=4, rev=202604),
                  row(type="Ret.", status="재계약완료", monthly=-1, rev=202604)])
    p = params()
    a = A.acr_view(ds, p)
    d = A.detail_view(ds, p, {"scope": "acr"})
    assert d["total"] == a["totals"]["funnels"]
    assert sum(r["monthly"] for r in d["rows"]) == a["totals"]["ACR"]
    m4 = A.detail_view(ds, p, {"scope": "acr", "ym": 202604})
    assert m4["total"] == [m for m in a["monthly"] if m["ym"] == 202604][0]["funnels"]


def test_product_groups(make_ds, params):
    # 전용회선 = 국내전용+국제전용, 전용회선외 = 나머지. 슬롯 금액만 합산, 카테고리 합 = 상품 슬롯 합
    ds = make_ds([
        row(monthly=10, rev=202603, 상품1="국내전용", 월매출1=6, 상품2="프리밴", 월매출2=4),
        row(monthly=3, rev=202603, 상품1="국제전용", 월매출1=3),
        row(monthly=5, rev=202604, 상품1="VoIP", 월매출1=5),
    ])
    tot = {}
    for g in ("all", "leased", "non_leased"):
        p = A.resolve_product_group(ds, params(product_group=g))
        tot[g] = A.acr_view(ds, p)["totals"]
    assert tot["all"]["ACR"] == 18
    assert tot["leased"]["ACR"] == 9 and tot["leased"]["funnels"] == 2
    assert tot["non_leased"]["ACR"] == 9 and tot["non_leased"]["funnels"] == 2
    assert tot["leased"]["ACR"] + tot["non_leased"]["ACR"] == tot["all"]["ACR"]
    # 개별 상품 선택과 카테고리는 교집합
    p = A.resolve_product_group(ds, params(product_group="leased", products=["국제전용", "VoIP"]))
    assert p.products == ["국제전용"] and A.acr_view(ds, p)["totals"]["ACR"] == 3
    p = A.resolve_product_group(ds, params(product_group="leased", products=["VoIP"]))
    assert A.acr_view(ds, p) == {"empty": True}
    assert "카테고리" in A.params_summary(p)["상품"]


def test_presales_bands(make_ds, params):
    ds = make_ds([
        row(fid="P0", status="Pre Sales", prob="10%(하하)", monthly=1, rev=202612),
        row(fid="P30", status="Pre Sales", prob="30%(하상)", monthly=2, rev=202612),
        row(fid="P50", status="제안완료", prob="50%(중중)", monthly=4, rev=202701),
        row(fid="P100", status="Pre Sales", prob="100%(수의계약예정)", monthly=8, rev=202612),
        row(fid="PX", status="Pre Sales", prob=None, monthly=16, rev=202612),
        row(fid="POUT", status="Pre Sales", prob="50%(중중)", monthly=32, rev=202901),   # 기간 밖
        row(fid="W", status="Win", prob="100%(수주완료)", monthly=64, rev=202612),         # 진행 중 아님
        row(fid="R1", type="Ret.", status="Pre Sales", prob="70%(상하)", prev=10, new=9, monthly=-1, rev=202612),
    ])
    p = params(ym_from="2026-01", ym_to="2027-12")
    v = A.presales_view(ds, p)
    a = {b["band"]: b for b in v["types"]["A"]["bins"]}
    assert a["30%이하"]["count"] == 1 and a["30%이상"]["count"] == 1 and a["50%이상"]["proposal"] == 1
    assert a["100%이상"]["monthly"] == 8 and a["미확인"]["count"] == 1 and a["미확인"]["weighted"] is None
    assert a["50%이상"]["cum_count"] == 2 and a["50%이상"]["cum_monthly"] == 12   # 50~100%
    assert a["30%이하"]["cum_count"] == 4                                          # 미확인 제외 전체
    t = v["types"]["A"]["totals"]
    assert t["count"] == 5 and t["monthly"] == 31 and t["weighted"] == 0.1 + 0.6 + 2 + 8
    assert v["types"]["A"]["excluded"]["out_of_period"] == 1
    r = {b["band"]: b for b in v["types"]["R"]["bins"]}
    assert r["70%이상"]["monthly"] == -1 and r["70%이상"]["prev"] == 10
    d = A.detail_view(ds, p, {"scope": "in_progress", "acr_type": ["A"], "prob_band": "30%이하", "period": "rev_ym"})
    assert d["total"] == 1 and d["rows"][0]["funnel_id"] == "P0"


def test_total_view_contract_amount_by_win_month(make_ds, params):
    ds = make_ds([
        row(fid="A1", type="Acq.", status="Win", win=202611, rev=202612, term=24, monthly=10, contract=240),
        row(fid="A2", type="Acq.", status="Pre Sales", win=202611, contract=999),                  # 진행 중 제외
        row(fid="A3", type="Acq.", status="Win", win=202701, contract=50),                          # 다른 연도
        row(fid="C1", type="Cul.", status="Win", win=202603, contract=120),
        row(fid="C2", type="Cul.", status="Win", win=202603, contract=None),                        # 누락 → 제외 건수
        row(fid="R1", type="Ret.", status="재계약완료", win=202605, prev=10, new=9, monthly=-1, term=12, contract=-12),
        row(fid="R2", type="Ret.", status="해지확정", win=202605, contract=-30),                      # 해지 제외
    ])
    v = A.total_view(ds, params(base_date="2026-11-04"))
    t = v["totals"]
    assert v["year"] == 2026 and t["A"] == 240 and t["C"] == 120 and t["R"] == -12 and t["ACR"] == 348
    assert t["funnels"] == 3 and v["excluded"] == {"계약기간매출(또는 상품 월매출·계약기간) 누락": 1}
    mon = {m["ym"]: m for m in v["monthly"]}
    assert mon[202611]["A"] == 240 and mon[202612]["A"] == 0 and mon[202612]["cum_ACR"] == 348
    assert v["r_ref"]["new_total"] == 108 and v["r_ref"]["prev_total"] == 120 and v["r_ref"]["decrease_count"] == 1
    assert A.total_view(ds, params(base_date="2026-11-04", total_year=2027))["totals"]["A"] == 50
    d = A.detail_view(ds, params(base_date="2026-11-04"), {"scope": "total", "win_month": 202611})
    assert d["total"] == 1 and d["rows"][0]["funnel_id"] == "A1"


def _edge_hist_rows():
    return [
        row(fid="W_PRE", status="Win", win=202606, hist="30%(하상)(2026/03/01),60%(중상)(2026/04/10),100%(수주완료)(2026/06/02)"),
        row(fid="W_SAME", status="Win", win=202606, hist="60%(중상)(2026/06/02),100%(수주완료)(2026/06/02)"),
        row(fid="W_100", status="Win", win=202606, type="Cul.", hist="100%(수주완료)(2026/06/02)"),
        row(fid="W_NOH", status="Win", win=202606, hist=None),
        row(fid="L_HI", status="Lose", win=202606, hist="80%(상중)(2026/02/01),0%(수주실패)(2026/06/01)"),
        row(fid="L_LO", status="Lose", win=202606, type="Cul.", hist="30%(하상)(2026/02/01),0%(수주실패)(2026/06/01)"),
        row(fid="D1", status="Drop", win=202606, hist="10%(하하)(2026/01/01),0%(DROP)(2026/06/01)"),
        row(fid="R_DONE_CONF", type="Ret.", status="재계약완료", win=202609, prev=10, new=9, monthly=-1,
            hist="70%(상하)(2026/09/15)", conf="2026-10-26 14:54:31"),
        row(fid="R_DONE_SAME", type="Ret.", status="재계약완료", win=202608, prev=5, new=5, monthly=0,
            hist="50%(중중)(2026/08/26)", conf="2026-08-26 15:47:17"),
        row(fid="R_CHURN", type="Ret.", status="해지확정", win=202607, prev=20, new=0, monthly=-20, 해지사유="예산"),
        row(fid="P_DROP", status="Pre Sales", win=202612, upd="2026-10-30", hist="70%(상하)(2026/05/01),40%(중하)(2026/09/01)"),
        row(fid="P_OLD", status="Pre Sales", win=202612, upd="2026-07-01", hist="30%(하상)(2024/05/01)"),
        row(fid="P_EQ", status="Pre Sales", win=202612, upd="2026-08-10", hist="50%(중중)(2025/11/08)"),
        row(fid="R_LOW", type="Ret.", status="Pre Sales", win=202611, prev=30, new=30, monthly=0, prob="30%(하상)",
            upd="2026-11-01", hist="30%(하상)(2026/10/01)"),
        row(fid="R_LOW_FAR", type="Ret.", status="Pre Sales", win=202702, prev=3, new=3, monthly=0, prob="10%(하하)",
            upd="2026-11-01", hist="10%(하하)(2026/10/01)"),
    ]


def test_history_registration_types(make_ds):
    ds = make_ds(_edge_hist_rows())
    rt = dict(zip(ds.df["funnel_id"], ds.df["reg_type"]))
    assert rt["W_PRE"] == "사전" and rt["W_SAME"] == "사후·당일" and rt["W_100"] == "사후·당일"
    assert rt["W_NOH"] == "이력 없음"
    assert rt["R_DONE_CONF"] == "사전"        # 100% 없음 → 확정일자(10/26) 기준, 9/15 등록
    assert rt["R_DONE_SAME"] == "사후·당일"   # 등록일 = 확정일
    assert ds.df.set_index("funnel_id").loc["W_PRE", "lead_days"] == 93


def test_perf_rates_and_sample(make_ds, params):
    ds = make_ds(_edge_hist_rows())
    t = A.perf_view(ds, params(base_date="2026-11-08", total_year=2026))["total"]
    ac = t["AC"]
    assert (ac["win"], ac["lose"], ac["drop"]) == (4, 2, 1)
    assert ac["simple"]["num"] == 4 and ac["simple"]["den"] == 7 and not ac["simple"]["ok"]   # Win÷(Win+Lose+Drop), 10건 미만
    assert ac["pre"]["num"] == 1 and ac["pre"]["den"] == 3                                     # 사전 Win ÷ (사전 Win + Lose), Drop 제외
    assert ac["reg"]["num"] == 1 and ac["reg"]["den"] == 3                                     # 이력 없는 Win 제외
    assert t["overconf"]["num"] == 1 and t["overconf"]["den"] == 2
    assert t["ret_cnt"]["num"] == 2 and t["ret_cnt"]["den"] == 3
    assert t["ret_amt"]["rate"] == (9 + 5) / (10 + 5 + 20)
    assert t["churn_top"] == "예산 (1건)"
    t2 = A.perf_view(ds, params(base_date="2026-11-08", total_year=2026, th={"min_sample": 3}))["total"]
    assert t2["AC"]["simple"]["ok"] and t2["AC"]["pre"]["ok"]


def test_new_check_rules(make_ds, params):
    ds = make_ds(_edge_hist_rows())
    p = params(base_date="2026-11-08")
    assert "PROB_DROP" in codes_of(ds, p, "P_DROP")
    assert "LONG_STAY" in codes_of(ds, p, "P_OLD")
    assert "LONG_STAY" not in codes_of(ds, p, "P_EQ")          # 정확히 365일 → 초과 아님
    assert "STALE_LONG" in codes_of(ds, p, "P_OLD")            # 7/1 → 130일
    assert "STALE_LONG" not in codes_of(ds, p, "P_EQ")          # 8/10 → 90일(초과 아님)
    assert "RENEWAL_LOWPROB" in codes_of(ds, p, "R_LOW")
    assert "RENEWAL_LOWPROB" not in codes_of(ds, p, "R_LOW_FAR")  # 예정월 임박 아님
    assert A.RULE_MAP["STALE"][1] == 3 and A.RULE_MAP["STALE_LONG"][1] == 1
