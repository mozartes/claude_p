/* 공공영업 통합 대시보드 — 화면 로직 (외부 네트워크 없이 동작) */
(function () {
  "use strict";

  const ROOT = document.getElementById("app");
  const API = ROOT.dataset.api; // 서버가 URL_PREFIX 를 반영해 전달
  const ADMIN_REQUIRED = ROOT.dataset.admin === "1";
  const COLORS = { A: "#2a78d6", C: "#eda100", R: "#eb6834", AC: "#6250d6", ACR: "#1f2937" };
  const css = (name, fb) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; } catch (e) { return fb; } };
  const SERIES_LABEL = { A: "A", C: "C", R: "R", AC: "A+C", ACR: "A+C+R" };
  const UNIT_WON = { "원": 1, "천원": 1e3, "백만원": 1e6, "억원": 1e8 };
  const PAGE_TITLES = {
    overview: "종합 현황", funnel: "수주·Funnel 관리", renewal: "재계약·해지 관리", acr: "ACR 수주", presales: "ACR 수주(Pre-sales)", total: "ACR 수주(총액)",
    team: "팀·AM 관리", perf: "AM 성과·활동 점검", insight: "고객·상품·입찰 분석", priority: "우선 확인할 Funnel", detail: "상세 목록", data: "데이터 관리",
  };

  const S = {
    meta: null, page: "overview", charts: [], last: null,
    f: null, // filters
    ui: { srcUnit: "unknown", dispUnit: "백만원", dec: 2, acrSeries: ["A", "C", "R", "ACR"], insightTab: "customer" },
    detail: { drill: {}, page: 1, sort: "row", desc: false, q: "", size: 50 },
  };

  // ------------------------------------------------------------ 유틸
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("psd:" + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("psd:" + k, JSON.stringify(v)); } catch (e) { /* 무시 */ } },
  };
  function unitFactor() {
    if (S.ui.srcUnit === "unknown" || !UNIT_WON[S.ui.srcUnit]) return 1;
    return UNIT_WON[S.ui.srcUnit] / UNIT_WON[S.ui.dispUnit];
  }
  // 서버에서 원본 단위가 확정(SOURCE_UNIT≠unknown)되면 화면에서 바꿀 수 없음
  function unitLocked() { return !!(S.meta && S.meta.unit && S.meta.unit.source_unit !== "unknown"); }
  function unitName() { return S.ui.srcUnit === "unknown" ? "원본 단위·확인 필요" : S.ui.dispUnit; }
  function conv(v) { return v == null ? null : v * unitFactor(); }
  function fmtNum(v, dec) {
    if (v == null || Number.isNaN(v)) return '<span class="nodata">자료 없음</span>';
    const d = dec == null ? S.ui.dec : dec;
    const s = Math.abs(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
    if (v < 0 && Number(s.replace(/,/g, "")) !== 0) return '<span class="neg">−' + s + "</span>";
    return s;
  }
  const amt = (v) => fmtNum(conv(v));
  const cnt = (v) => (v == null ? '<span class="nodata">자료 없음</span>' : Number(v).toLocaleString("ko-KR"));
  const pct = (v) => (v == null ? '<span class="nodata">산출 불가</span>' : (v < 0 ? '<span class="neg">−' + Math.abs(v * 100).toFixed(1) + "%</span>" : (v * 100).toFixed(1) + "%"));
  const typeTag = (t) => (t ? `<span class="tag t-${esc(t)}">${esc(t)}</span>` : "");
  const lvTag = (lv) => (lv ? `<span class="lv lv${lv}">${["", "높음", "중간", "낮음"][lv]}</span>` : "");

  async function api(path, body) {
    const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const r = await fetch(API + path, opt);
    let j = null;
    try { j = await r.json(); } catch (e) { /* noop */ }
    if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || `요청 실패 (${r.status})`);
    return j;
  }

  // ------------------------------------------------------------ 필터
  function defaultFilters() {
    const d = S.meta.defaults;
    return {
      base_date: d.base_date, ym_from: d.ym_from, ym_to: d.ym_to, level: "all", teams: [], ams: [],
      types: ["A", "C", "R"], products: [], product_group: "all", search: "", mode: "start",
      excl_midlarge: false, excl_rmr: false, confirmed_only: false, th: Object.assign({}, d.th), _dv: d.version,
    };
  }
  function renderFilterInputs() {
    const f = S.f, o = S.meta.options;
    $("f_base").value = f.base_date; $("f_from").value = f.ym_from; $("f_to").value = f.ym_to;
    document.querySelectorAll("#f_level button").forEach((b) => b.classList.toggle("on", b.dataset.v === f.level));
    $("f_teams").innerHTML = o.teams.length ? o.teams.map((t) => `<label><input type="checkbox" value="${esc(t)}" ${f.teams.includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("") : '<span class="side-note">자료 없음</span>';
    renderAmList();
    document.querySelectorAll("#f_types input").forEach((i) => (i.checked = f.types.includes(i.value)));
    $("f_pgroup").value = f.product_group || "all";
    renderProductList();
    $("f_search").value = f.search; $("f_mode").value = f.mode;
    $("f_excl_midlarge").checked = f.excl_midlarge; $("f_excl_rmr").checked = f.excl_rmr; $("f_confirmed_only").checked = f.confirmed_only;
    $("th_stale").value = f.th.stale_days; $("th_large").value = f.th.large_contract_amount; $("th_large_r").value = f.th.large_renewal_monthly;
    $("th_imm").value = f.th.imminent_months; $("th_prob").value = f.th.high_probability;
    $("th_stale_long").value = f.th.stale_long_days; $("th_long_stay").value = f.th.long_stay_days; $("th_ren_low").value = f.th.renewal_low_prob; $("th_min").value = f.th.min_sample;
    $("u_src").value = S.ui.srcUnit; $("u_disp").value = S.ui.dispUnit; $("u_dec").value = String(S.ui.dec);
    $("u_disp").disabled = S.ui.srcUnit === "unknown";
    $("u_src").disabled = unitLocked();
    updateCounts();
  }
  function renderAmList() {
    const f = S.f, q = ($("amSearch").value || "").trim();
    const teamsSel = selectedValues("f_teams");
    const list = S.meta.options.ams.filter((a) => (!teamsSel.length || teamsSel.includes(a.team)) && (!q || a.am.includes(q)));
    let html = "", grp = null;
    list.forEach((a) => {
      if (a.team !== grp) { grp = a.team; html += `<div class="grp">${esc(grp)}</div>`; }
      html += `<label><input type="checkbox" value="${esc(a.key)}" ${f.ams.includes(a.key) ? "checked" : ""}> ${esc(a.am)}</label>`;
    });
    $("f_ams").innerHTML = html || '<span class="side-note">해당 AM 없음</span>';
  }
  // 상품 카테고리: 전용회선 = 국내전용+국제전용(원본 표기), 전용회선외 = 나머지
  function inGroup(p, g) {
    g = g || S.f.product_group || "all";
    if (g === "all") return true;
    const leased = (S.meta.options.leased_products || []).includes(p);
    return g === "leased" ? leased : !leased;
  }
  function renderProductList() {
    const q = ($("prodSearch").value || "").trim();
    const list = S.meta.options.products.filter((p) => inGroup(p) && (!q || p.toLowerCase().includes(q.toLowerCase())));
    $("f_products").innerHTML = list.map((p) => `<label><input type="checkbox" value="${esc(p)}" ${S.f.products.includes(p) ? "checked" : ""}> ${esc(p)}</label>`).join("") || '<span class="side-note">자료 없음</span>';
  }
  function selectedValues(id) { return Array.from(document.querySelectorAll(`#${id} input:checked`)).map((i) => i.value); }
  function updateCounts() {
    $("teamCount").textContent = S.f.teams.length ? `${S.f.teams.length}개 선택` : "전체";
    $("amCount").textContent = S.f.ams.length ? `${S.f.ams.length}명 선택` : "전체";
    const gl = { all: "전체(월매출합계)", leased: "전용회선 전체(상품 월매출)", non_leased: "전용회선외 전체(상품 월매출)" }[S.f.product_group || "all"];
    $("prodCount").textContent = S.f.products.length ? `${S.f.products.length}개 선택(상품 월매출)` : gl;
  }
  function readFilters() {
    const f = S.f;
    f.base_date = $("f_base").value || S.meta.defaults.base_date;
    f.ym_from = $("f_from").value || S.meta.defaults.ym_from;
    f.ym_to = $("f_to").value || S.meta.defaults.ym_to;
    f.teams = selectedValues("f_teams");
    // 선택 팀에 속하지 않는 AM 선택은 해제
    const amSel = new Set(selectedValues("f_ams"));
    const keep = f.ams.filter((k) => !document.querySelector(`#f_ams input[value="${CSS.escape(k)}"]`));
    f.ams = Array.from(new Set([...keep, ...amSel])).filter((k) => !f.teams.length || f.teams.includes(k.split("|")[0]));
    f.types = selectedValues("f_types"); if (!f.types.length) f.types = ["A", "C", "R"];
    const prodSel = new Set(selectedValues("f_products"));
    const keepP = f.products.filter((k) => !document.querySelector(`#f_products input[value="${CSS.escape(k)}"]`));
    f.products = Array.from(new Set([...keepP, ...prodSel])).filter((x) => inGroup(x));
    f.product_group = $("f_pgroup").value || "all";
    f.search = $("f_search").value.trim(); f.mode = $("f_mode").value;
    f.excl_midlarge = $("f_excl_midlarge").checked; f.excl_rmr = $("f_excl_rmr").checked; f.confirmed_only = $("f_confirmed_only").checked;
    const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
    const th0 = S.meta.defaults.th;
    f.th = { stale_days: num("th_stale", th0.stale_days), large_contract_amount: num("th_large", th0.large_contract_amount),
      large_renewal_monthly: num("th_large_r", th0.large_renewal_monthly), imminent_months: num("th_imm", th0.imminent_months), high_probability: num("th_prob", th0.high_probability),
      stale_long_days: num("th_stale_long", th0.stale_long_days), long_stay_days: num("th_long_stay", th0.long_stay_days), renewal_low_prob: num("th_ren_low", th0.renewal_low_prob), min_sample: num("th_min", th0.min_sample) };
    S.ui.srcUnit = unitLocked() ? S.meta.unit.source_unit : $("u_src").value; S.ui.dispUnit = $("u_disp").value; S.ui.dec = parseInt($("u_dec").value, 10);
    store.set("filters", f); store.set("ui", S.ui);
    updateCounts();
  }

  // ------------------------------------------------------------ 공통 렌더
  function destroyCharts() { S.charts.forEach((c) => c.destroy()); S.charts = []; }
  function loading() { $("view").innerHTML = '<div class="state"><div class="spinner"></div>불러오는 중…</div>'; }
  function errorState(msg) { $("view").innerHTML = `<div class="notice neg">오류: ${esc(msg)}<br>잠시 후 다시 조회하거나 관리자에게 logs/app.log 확인을 요청하세요.</div>`; }
  function emptyState() {
    return `<div class="card"><div class="state"><b>자료 없음</b><br>원본 Funnel 엑셀이 아직 적용되지 않았거나 조건에 맞는 데이터가 없습니다.<br>
      <span class="link" data-goto="data">데이터 관리</span>에서 엑셀을 업로드하거나 필터를 조정하세요.</div></div>`;
  }
  function setHeader(j) {
    $("pageTitle").textContent = PAGE_TITLES[S.page];
    const ds = j ? j.dataset : (S.meta ? S.meta.dataset : null);
    const chip = $("dataChip");
    if (!ds || ds.empty) { chip.className = "chip warn"; chip.textContent = "원본 데이터 없음"; }
    else {
      chip.className = "chip gray";
      chip.textContent = `원본: ${ds.file_name || "-"} · ${ds.uploaded_at || "-"} · ${Number(ds.rows || ds.row_count || 0).toLocaleString()}건`
        + (ds.agg_excluded_rows ? ` · 집계 제외 ${ds.agg_excluded_rows}건` : "");
    }
    const wc = $("warnChip");
    if (wc) {
      const ws = (ds && ds.warnings) || [];
      wc.hidden = !ws.length;
      wc.textContent = ws.length ? `원본 확인 필요 ${ws.length}건` : "";
      wc.title = ws.join("\n");
    }
    const u = $("unitChip");
    u.className = S.ui.srcUnit === "unknown" ? "chip warn" : "chip ok";
    u.textContent = S.ui.srcUnit === "unknown" ? "단위: 원본 단위·확인 필요(변환 안 함)"
      : (S.ui.dispUnit === S.ui.srcUnit ? `단위: ${S.ui.dispUnit}` : `단위: ${S.ui.dispUnit} (원본 ${S.ui.srcUnit} 환산)`);
    if (j && j.applied) {
      const a = j.applied;
      $("pageSub").textContent = `기준일 ${a["기준일"]} · 조회기간 ${a["조회기간"]} · ${a["ACR 기준"]}`;
      const chips = [["집계", a["집계 수준"]], ["팀", a["팀"]], ["AM", a["AM"]], ["유형", a["ACR유형"]], ["상품 카테고리", a["상품 카테고리"] === "상품전체(모든 상품)" ? "전체" : a["상품 카테고리"]], ["상품", a["상품"]], ["검색", a["검색"]], ["보조필터", a["보조필터"]]];
      $("applied").innerHTML = chips.map(([k, v]) => `<span class="chip ${v === "전체" || v === "없음" || v === "미적용" ? "gray" : ""}">${esc(k)}: ${esc(String(v).length > 60 ? String(v).slice(0, 60) + "…" : v)}</span>`).join("");
    }
  }
  function basisBlock(b, title) {
    if (!b) return "";
    return `<details class="card" style="margin-top:14px"><summary><b>${esc(title || "계산 기준")}</b> <span class="muted">(펼치기)</span></summary>
      <dl class="basis" style="margin-top:8px">${Object.entries(b).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>`;
  }
  function kpiCard(label, value, meta, cls, drill) {
    return `<div class="card kpi ${cls || ""}" ${drill ? `data-drill='${esc(JSON.stringify(drill))}'` : ""} tabindex="0" role="button">
      <div class="bar"></div><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="meta">${meta || ""}</div></div>`;
  }
  // 목록 테이블(우선 확인/상세 공통)
  function funnelTable(rows, opts) {
    opts = opts || {};
    if (!rows || !rows.length) return '<div class="state">해당 건 없음</div>';
    const cols = opts.compact
      ? ["customer", "am", "acr_type", "status", "win_ym", "rev_ym", "check_amount", "updated_at"]
      : opts.priority
      ? ["rank", "level", "checks", "actions", "team", "am", "customer", "funnel_id", "acr_type", "status", "win_ym", "rev_ym", "check_amount", "updated_at"]
      : ["funnel_id", "customer", "team", "am", "acr_type", "status", "win_ym", "rev_ym", "monthly", "contract_amt", "prev_monthly", "new_monthly", "updated_at", "checks"];
    const H = { rank: "순위", level: "우선순위", checks: "확인 사유", actions: "권장 확인 행동", team: "팀", am: "AM", customer: "고객사", funnel_id: "Funnel번호",
      acr_type: "유형", status: "현재상황", win_ym: "수주년월", rev_ym: "매출발생년월", check_amount: "금액(기준)", updated_at: "최근 갱신일",
      monthly: "월매출합계", contract_amt: "계약기간매출", prev_monthly: "기존매출", new_monthly: "변경매출" };
    const numCols = new Set(["check_amount", "monthly", "contract_amt", "prev_monthly", "new_monthly", "rank"]);
    const cell = (r, c) => {
      switch (c) {
        case "level": return lvTag(r.level);
        case "checks": return (r.checks || []).map((x) => `<span class="tag">${esc(x)}</span>`).join("") || '<span class="muted">-</span>';
        case "actions": return (r.actions || []).map(esc).join("<br>");
        case "acr_type": return typeTag(r.acr_type);
        case "am": return opts.compact ? `${esc(r.am)} <span class="muted">${esc(r.team)}</span>` : esc(r.am);
        case "customer": return opts.compact ? `${esc(r.customer)}<br><span class="muted" style="font-size:11px">${esc(r.funnel_id)}</span>` : esc(r.customer);
        case "check_amount": return `${amt(r.check_amount)}<br><span class="muted" style="font-size:11px">${esc(r.check_amount_basis || "")}</span>`;
        case "monthly": case "contract_amt": case "prev_monthly": case "new_monthly": return amt(r[c]);
        case "updated_at": return r.updated_at ? esc(r.updated_at) : '<span class="muted">갱신일 미입력</span>';
        case "rev_ym": case "win_ym": return r[c] ? esc(r[c]) : '<span class="muted">미입력</span>';
        default: return esc(r[c]);
      }
    };
    return `<div class="table-wrap" style="${opts.maxH ? `max-height:${opts.maxH}px` : ""}"><table class="t"><thead><tr>${cols.map((c) => `<th class="${numCols.has(c) ? "num" : ""}">${H[c]}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="clickable" data-row="${r.row}">${cols.map((c) => `<td class="${numCols.has(c) ? "num" : (c === "checks" || c === "actions" ? "wrap" : "")}">${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function reasonTable(rt, title) {
    if (!rt || !rt.total) return `<div><b>${esc(title)}</b><div class="muted">해당 건 없음</div></div>`;
    return `<div><b>${esc(title)}</b> <span class="muted">(${rt.total}건, 미입력 ${rt.missing}건 · ${pct(rt.missing_ratio)})</span>
      <div class="table-wrap" style="max-height:240px;margin-top:4px"><table class="t"><thead><tr><th>사유(원문)</th><th class="num">건수</th></tr></thead>
      <tbody>${rt.items.map((i) => `<tr><td class="wrap">${esc(i.reason)}</td><td class="num">${cnt(i.count)}</td></tr>`).join("")}</tbody></table></div></div>`;
  }
  function rulesBlock(rules) {
    if (!rules) return "";
    return `<details class="card" style="margin-top:14px"><summary><b>우선 확인 규칙(설명 가능한 조건)</b> <span class="muted">— 업무 확인 순서이며 수주 확률·AM 평가점수가 아님</span></summary>
      <div class="table-wrap" style="margin-top:8px"><table class="t"><thead><tr><th>등급</th><th>사유</th><th>조건</th><th>권장 행동</th></tr></thead>
      <tbody>${rules.map((r) => `<tr><td>${lvTag(r.level)}</td><td>${esc(r.label)}</td><td class="wrap" style="max-width:520px">${esc(r.condition)}</td><td class="wrap">${esc(r.action)}</td></tr>`).join("")}</tbody></table></div></details>`;
  }

  // ------------------------------------------------------------ 차트
  const zeroGrid = { color: (ctx) => (ctx.tick && ctx.tick.value === 0 ? "#6b7280" : "#eef1f6"), lineWidth: (ctx) => (ctx.tick && ctx.tick.value === 0 ? 1.5 : 1) };
  function chart(canvasId, cfg) {
    const el = $(canvasId);
    if (!el || typeof Chart === "undefined") return null;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = "#4b5563";
    const c = new Chart(el, cfg);
    S.charts.push(c);
    return c;
  }
  function tooltipAmt(ctx) { return `${ctx.dataset.label}: ${fmtNum(ctx.parsed.y != null && ctx.chart.options.indexAxis !== "y" ? ctx.parsed.y : ctx.parsed.x).replace(/<[^>]+>/g, "")}`; }
  function acrMonthlyChart(id, monthly, series, onClick) {
    const labels = monthly.map((m) => m.label);
    const ds = [];
    ["A", "C", "R"].forEach((k) => { if (series.includes(k)) ds.push({ type: "bar", label: SERIES_LABEL[k], key: k, data: monthly.map((m) => conv(m[k])), backgroundColor: COLORS[k], borderRadius: 3, maxBarThickness: 18, order: 2 }); });
    ["AC", "ACR"].forEach((k) => { if (series.includes(k)) ds.push({ type: "line", label: SERIES_LABEL[k], key: k, data: monthly.map((m) => conv(m[k])), borderColor: COLORS[k], backgroundColor: COLORS[k], borderWidth: 2, pointRadius: 3, tension: 0, order: 1 }); });
    return chart(id, {
      data: { labels, datasets: ds },
      options: {
        maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: tooltipAmt } } },
        scales: { y: { title: { display: true, text: `월별 금액 (${unitName()})` }, grid: zeroGrid }, x: { grid: { display: false } } },
        onClick: (evt, els, c) => {
          const pts = c.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
          if (!pts.length) return;
          const m = monthly[pts[0].index];
          const near = c.getElementsAtEventForMode(evt, "nearest", { intersect: true }, false);
          const key = near.length ? c.data.datasets[near[0].datasetIndex].key : null;
          onClick && onClick(m, key);
        },
      },
    });
  }

  // ------------------------------------------------------------ 페이지: 종합 현황
  async function pageOverview() {
    const j = await api("/view/overview", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const k = d.kpi, a = k.acr;
    const ml = S.f.mode === "term" ? "계약기간 반영 추정" : "매출개시월 기준";
    const acDrill = { scope: "acr", acr_type: ["A", "C"] };
    // 누적매출 = 조회기간(매출발생년월 기준) 확정 ACR 월매출 증감액의 합계
    const accBasis = `확정 ACR · ${ml} · ${S.f.ym_from}~${S.f.ym_to} 합계`;
    let h = `<div class="grid kpis">
      ${kpiCard("A+C 누적매출", amt(a.AC), `A ${amt(a.A)} · C ${amt(a.C)} · Funnel ${cnt(a.funnels_A + a.funnels_C)}건<br>${esc(accBasis)}`, "a", acDrill)}
      ${kpiCard("R 누적매출", amt(a.R), `재계약완료 Funnel ${cnt(a.funnels_R)}건(감액건 포함)<br>${esc(accBasis)}`, "r", { scope: "acr", acr_type: ["R"] })}
      ${kpiCard("A+C+R 누적매출", amt(a.ACR), `고유 Funnel ${cnt(a.funnels)}건<br>${esc(accBasis)}`, "", { scope: "acr" })}
      ${kpiCard("진행 중 A/C Funnel", cnt(k.prog_ac_count) + "건", `계약기간매출 ${amt(k.prog_ac_amount.total)}${k.prog_ac_amount.neg_count ? ` (음수 ${k.prog_ac_amount.neg_count}건 ${amt(k.prog_ac_amount.negative)})` : ""}`, "", { scope: "in_progress", acr_type: ["A", "C"] })}
      ${kpiCard("진행 중 재계약(R)", cnt(k.prog_r_count) + "건", `기존 월매출 ${amt(k.prog_r_prev)}`, "", { scope: "in_progress", acr_type: ["R"] })}
      ${kpiCard("해지확정", cnt(k.churn_count) + "건", "수주년월 기간 내 · 확정 ACR 합계 제외", "neg", { status: ["해지확정"], period: "win_ym" })}
      ${kpiCard("확인 필요 Funnel", cnt(k.check_count) + "건", `높음 등급 ${cnt(k.check_level1)}건 · 고유 Funnel`, "warn", { scope: "checks" })}
    </div>`;
    if (d.acr_excluded && Object.keys(d.acr_excluded).length) {
      h += `<div class="notice warn">확정 ACR 조건이지만 계산에서 제외된 건: ${Object.entries(d.acr_excluded).map(([r, n]) => `${esc(r)} ${n}건`).join(", ")} <span class="link" data-drill='${esc(JSON.stringify({ scope: "acr_excluded" }))}'>목록 보기</span></div>`;
    }
    h += `<div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="card-head"><h3>월별 ACR 추이</h3><span class="muted">${esc(k.acr_mode_label)} · 막대/선 클릭 → 해당 월 Funnel</span></div>
        <p class="desc">막대 A·C·R, 선 A+C+R (같은 축, 단위 ${esc(unitName())}). 0 기준선 아래는 감액.</p>
        <div class="chart-box"><canvas id="ovChart"></canvas></div></div>
      <div class="card"><div class="card-head"><h3>팀·AM별 확인 과제</h3><span class="muted">집계 수준: ${S.f.level === "am" ? "AM" : "팀"}</span></div>
        <p class="desc">우선 확인 규칙에 해당하는 고유 Funnel 수(행 클릭 → 목록)</p>
        <div class="table-wrap" style="max-height:300px"><table class="t"><thead><tr><th>${S.f.level === "am" ? "AM(팀)" : "팀"}</th><th class="num">확인 Funnel</th><th class="num">높음</th><th class="num">예정월 경과</th><th class="num">감액 예상</th><th class="num">장기 미갱신(90일)</th></tr></thead>
        <tbody>${d.team_checks.map((t) => `<tr class="clickable" data-drill='${esc(JSON.stringify(S.f.level === "am" ? { scope: "checks", am_key: t.key } : { scope: "checks", team: t.key }))}'>
          <td>${esc(t.am ? `${t.am} (${t.team})` : t.team)}</td><td class="num">${cnt(t.funnels)}</td><td class="num">${cnt(t.level1)}</td>
          <td class="num">${cnt(t.by_code.OVERDUE || 0)}</td><td class="num">${cnt(t.by_code.RENEWAL_DECREASE || 0)}</td><td class="num">${cnt(t.by_code.STALE_LONG || 0)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">해당 없음</td></tr>'}</tbody></table></div></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="card-head"><h3>이번 달·다음 달 수주(재계약) 예정</h3><span class="link" data-drill='${esc(JSON.stringify({ scope: "in_progress", bucket: "이번 달" }))}'>이번 달 전체</span> <span class="link" data-drill='${esc(JSON.stringify({ scope: "in_progress", bucket: "다음 달" }))}'>다음 달 전체</span></div>
        <p class="desc">진행 중 ${cnt(d.upcoming_count)}건 · 수주년월을 예정월로 사용(업무 가정) · 상위 20건</p>${funnelTable(d.upcoming, { compact: true, maxH: 320 })}</div>
      <div class="card"><div class="card-head"><h3>예정월 경과 사업</h3><span class="link" data-drill='${esc(JSON.stringify({ scope: "in_progress", bucket: "예정월 경과" }))}'>전체 ${cnt(d.overdue_count)}건</span></div>
        <p class="desc">진행 중이며 수주년월이 기준월보다 이전 → 수주 일정·현재 단계 확인</p>${funnelTable(d.overdue, { compact: true, maxH: 320 })}</div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="card-head"><h3>재계약 감액 예상</h3><span class="link" data-drill='${esc(JSON.stringify({ scope: "checks", code: "RENEWAL_DECREASE" }))}'>전체 ${cnt(d.renewal_decrease_count)}건</span></div>
        <p class="desc">R 진행 중 · 변경매출 &lt; 기존매출 또는 월매출합계 &lt; 0 → 감액 사유·방어 방안 확인</p>${funnelTable(d.renewal_decrease, { compact: true, maxH: 300 })}</div>
      <div class="card"><div class="card-head"><h3>해지확정 (기존매출 큰 순)</h3><span class="link" data-drill='${esc(JSON.stringify({ status: ["해지확정"], period: "win_ym" }))}'>전체 ${cnt(k.churn_count)}건</span></div>
        <p class="desc">수주년월 기간 내 · 해지월로 단정하지 않음 · 확정 ACR 합계에서 제외</p>${funnelTable(d.churn, { compact: true, maxH: 300 })}</div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-head"><h3>우선 확인할 Funnel (상위 20)</h3><span class="link" data-goto="priority">전체 목록</span></div>
      <p class="desc">여러 사유에 해당하면 한 행에 모아 표시 · 등급 → 사유 수 → 금액 순</p>${funnelTable(d.priority, { priority: true, maxH: 520 })}</div>
    ${basisBlock(d.basis)}${rulesBlock(d.rules)}`;
    $("view").innerHTML = h;
    acrMonthlyChart("ovChart", d.acr_monthly, ["A", "C", "R", "ACR"], (m, key) => openDetail({ scope: "acr", ym: m.ym, acr_type: key && ["A", "C", "R"].includes(key) ? [key] : undefined }));
  }

  // ------------------------------------------------------------ 페이지: 수주·Funnel
  async function pageFunnel() {
    const j = await api("/view/funnel", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const o = d.outcome, wt = d.weighted_total;
    let h = `<div class="grid kpis">${d.schedule.map((s) => kpiCard(`진행 중 A/C · ${s.bucket}`, cnt(s.count) + "건", `계약기간매출 ${amt(s.amount.total)}`, s.bucket === "예정월 경과" ? "neg" : (s.bucket === "예정월 미입력" ? "warn" : ""), { scope: "in_progress", acr_type: ["A", "C"], bucket: s.bucket })).join("")}</div>
      <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>① 현재 단계 분포 (A/C)</h3><p class="desc">수주년월 기간 내 현재 상태 · 과거 단계 이력이 없어 전환율·체류기간은 산출하지 않음</p>
        <div class="chart-box short"><canvas id="stageChart"></canvas></div>
        <div class="table-wrap" style="margin-top:8px"><table class="t"><thead><tr><th>단계</th><th class="num">건수</th><th class="num">계약기간매출</th></tr></thead>
        <tbody>${d.stage.map((s) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ acr_type: ["A", "C"], status: [s.status], period: "win_ym" }))}'><td>${esc(s.status)}</td><td class="num">${cnt(s.count)}</td><td class="num">${amt(s.amount)}</td></tr>`).join("")}</tbody></table></div>
        <p class="desc" style="margin-top:10px"><b>R 단계</b> (월매출합계 = 재계약 증감)</p>
        <div class="table-wrap"><table class="t"><thead><tr><th>단계</th><th class="num">건수</th><th class="num">기존 월매출</th><th class="num">변경 월매출</th><th class="num">월매출 증감</th></tr></thead>
        <tbody>${d.stage_r.map((s) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ acr_type: ["R"], status: [s.status], period: "win_ym" }))}'><td>${esc(s.status)}</td><td class="num">${cnt(s.count)}</td><td class="num">${amt(s.prev)}</td><td class="num">${amt(s.new)}</td><td class="num">${amt(s.monthly)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h3>③ 확인 필요 조건</h3><p class="desc">자동 오류 확정·수정이 아니라 확인 대상 표시입니다.</p>
        <div class="table-wrap"><table class="t"><thead><tr><th>조건</th><th>권장 행동</th><th class="num">건수</th></tr></thead>
        <tbody>${d.check_counts.map((c) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ scope: "checks", acr_type: ["A", "C"], code: c.code }))}'><td>${esc(c.label)}</td><td class="wrap">${esc(c.action)}</td><td class="num">${cnt(c.count)}</td></tr>`).join("")}</tbody></table></div>
        <h3 style="margin-top:16px">⑤ 종결 결과 (A/C, 수주년월 기준 현재 종결상태)</h3>
        <div class="table-wrap"><table class="t"><thead><tr><th>구분</th><th class="num">Win</th><th class="num">Lose</th><th class="num">Drop</th><th class="num">승패 결정 건 기준 수주율</th></tr></thead>
        <tbody><tr><td>A+C</td><td class="num">${cnt(o.win)}</td><td class="num">${cnt(o.lose)}</td><td class="num">${cnt(o.drop)}</td><td class="num">${pct(o.win_rate)}</td></tr>
        ${o.by_type.map((t) => `<tr><td>${typeTag(t.type)}</td><td class="num">${cnt(t.win)}</td><td class="num">${cnt(t.lose)}</td><td class="num">${cnt(t.drop)}</td><td class="num">${pct(t.win_rate)}</td></tr>`).join("")}
        <tr><td class="muted">계약기간매출</td><td class="num">${amt(o.win_amount)}</td><td class="num">${amt(o.lose_amount)}</td><td class="num">${amt(o.drop_amount)}</td><td></td></tr></tbody></table></div>
        <p class="desc" style="margin-top:6px">수주율 = Win/(Win+Lose), Drop은 분모 제외 · 분모 0이면 산출 불가 · 과거 시점 수주율 아님</p></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>④ 수주 가능성 (진행 중 A/C)</h3>
      <p class="desc">‘수주(재계약)가능성’의 명시적 0~100% 값만 사용, 변환 실패는 미확인. 가중 추정 = 계약기간매출 × 입력 가능성 — 통계적 예측이 아닌 입력값 기반 참고치이며 원본 ‘수주가능매출’과 동일시하지 않음.</p>
      <div class="table-wrap"><table class="t"><thead><tr><th>가능성 구간</th><th class="num">건수</th><th class="num">계약기간매출 합계</th><th class="num">양수 건</th><th class="num">0 건</th><th class="num">음수 건(금액)</th><th class="num">참고용 가중 추정</th></tr></thead>
      <tbody>${d.prob_bins.map((b) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ scope: "in_progress", acr_type: ["A", "C"], prob_bin: b.bin }))}'><td>${esc(b.bin)}</td><td class="num">${cnt(b.count)}</td><td class="num">${amt(b.amount.total)}</td><td class="num">${cnt(b.amount.pos_count)}</td><td class="num">${cnt(b.amount.zero_count)}</td><td class="num">${cnt(b.amount.neg_count)} (${amt(b.amount.negative)})</td><td class="num">${b.bin === "미확인" ? '<span class="muted">산출 불가</span>' : amt(b.weighted)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="6">가중 추정 합계 — 양수 / 음수 (상계하지 않음) · 포함 ${wt.included}건, 제외 ${wt.excluded}건</td><td class="num">${amt(wt.positive)} / ${amt(wt.negative)}</td></tr></tfoot></table></div></div>
    <div class="grid cols-3" style="margin-top:14px"><div class="card">${reasonTable(d.reasons.win, "Win 승패사유")}</div><div class="card">${reasonTable(d.reasons.lose, "Lose 승패사유")}</div><div class="card">${reasonTable(d.reasons.drop, "Drop 세부사유")}</div></div>
    <div class="card" style="margin-top:14px"><h3>확인 필요 Funnel (A/C, 상위 50)</h3>${funnelTable(d.checks, { priority: true, maxH: 520 })}</div>
    ${basisBlock(d.basis)}${rulesBlock(d.rules)}`;
    $("view").innerHTML = h;
    chart("stageChart", {
      type: "bar",
      data: { labels: d.stage.map((s) => s.status), datasets: [{ label: "건수", data: d.stage.map((s) => s.count), backgroundColor: "#2a78d6", borderRadius: 3, maxBarThickness: 40 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { title: { display: true, text: "건수" }, grid: zeroGrid }, x: { grid: { display: false } } },
        onClick: (e, els) => { if (els.length) openDetail({ acr_type: ["A", "C"], status: [d.stage[els[0].index].status], period: "win_ym" }); } },
    });
  }

  // ------------------------------------------------------------ 페이지: 재계약·해지
  async function pageRenewal() {
    const j = await api("/view/renewal", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const pa = d.prog_amount, ch = d.churn, cr = d.change_rate;
    let h = `<div class="grid kpis">
      ${kpiCard("진행 중 재계약", cnt(pa.count) + "건", `기존 ${amt(pa.prev)} → 변경 ${amt(pa.new)} (증감 ${amt(pa.monthly)})`, "r", { scope: "in_progress", acr_type: ["R"] })}
      ${kpiCard("재계약완료 (기간 내)", cnt(d.done_count) + "건", `금액 관계 불일치 ${cnt(d.mismatch)}건`, "", { acr_type: ["R"], status: ["재계약완료"], period: "win_ym" })}
      ${kpiCard("재계약 매출 증감률 (완료)", pct(cr.rate), `포함 ${cr.included}건 · 제외 ${cr.excluded}건 (기존매출 양수 대상)`, cr.rate < 0 ? "neg" : "", { acr_type: ["R"], status: ["재계약완료"], period: "win_ym" })}
      ${kpiCard("해지확정 (기간 내)", cnt(ch.count) + "건", `기존 월매출 ${amt(ch.prev)}`, "neg", { acr_type: ["R"], status: ["해지확정"], period: "win_ym" })}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>① 재계약 예정 (R 진행 중)</h3><p class="desc">수주년월을 재계약 예정월로 사용(업무 가정) · 기존 계약 만료일은 원본에 없어 표시하지 않음</p>
        <div class="table-wrap"><table class="t"><thead><tr><th>구분</th><th class="num">건수</th><th class="num">기존 월매출</th><th class="num">변경 월매출</th><th class="num">월매출 증감</th></tr></thead>
        <tbody>${d.schedule.map((s) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ scope: "in_progress", acr_type: ["R"], bucket: s.bucket }))}'><td>${esc(s.bucket)}</td><td class="num">${cnt(s.count)}</td><td class="num">${amt(s.prev)}</td><td class="num">${amt(s.new)}</td><td class="num">${amt(s.monthly)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>합계</td><td class="num">${cnt(pa.count)}</td><td class="num">${amt(pa.prev)}</td><td class="num">${amt(pa.new)}</td><td class="num">${amt(pa.monthly)}</td></tr></tfoot></table></div></div>
      <div class="card"><h3>② 재계약 금액 (재계약완료, 수주년월 기간 내)</h3><p class="desc">증액/동일/감액 = 월매출합계 부호 기준 · 재계약 후 월매출(변경매출)은 ACR 증감 합계에 더하지 않음</p>
        <div class="chart-box short"><canvas id="chgChart"></canvas></div>
        <div class="table-wrap" style="margin-top:8px"><table class="t"><thead><tr><th>구분</th><th class="num">건수</th><th class="num">기존 월매출</th><th class="num">변경 월매출</th><th class="num">월매출 증감</th></tr></thead>
        <tbody>${d.change.map((c) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ acr_type: ["R"], status: ["재계약완료"], period: "win_ym", change: c.class }))}'><td>${c.class === "감액" ? '<span class="neg">▼ 감액</span>' : c.class === "증액" ? "▲ 증액" : esc(c.class)}</td><td class="num">${cnt(c.count)}</td><td class="num">${amt(c.prev)}</td><td class="num">${amt(c.new)}</td><td class="num">${amt(c.monthly)}</td></tr>`).join("")}</tbody></table></div></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>③ 해지확정</h3><p class="desc">실제 해지일·청구 중단일이 없어 해지월로 단정하지 않음 · 기존 ${amt(ch.prev)} / 변경 ${amt(ch.new)} / 월매출합계 ${amt(ch.monthly)}</p>
        <div class="table-wrap" style="max-height:300px"><table class="t"><thead><tr><th>${S.f.level === "am" ? "AM(팀)" : "팀"}</th><th class="num">건수</th><th class="num">기존매출</th><th class="num">변경매출</th><th class="num">월매출합계</th></tr></thead>
        <tbody>${ch.by_org.map((r) => `<tr class="clickable" data-drill='${esc(JSON.stringify(Object.assign({ acr_type: ["R"], status: ["해지확정"], period: "win_ym" }, S.f.level === "am" ? { am_key: r.key } : { team: r.key })))}'><td>${esc(r.am ? `${r.am} (${r.team})` : r.team)}</td><td class="num">${cnt(r.count)}</td><td class="num">${amt(r.prev)}</td><td class="num">${amt(r.new)}</td><td class="num">${amt(r.monthly)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">해당 없음</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="grid cols-2">${reasonTable(ch.reason, "해지사유")}${reasonTable(ch.type, "해지유형")}</div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>④ 재계약 확인 목록</h3>
      <div class="toolbar">${d.check_counts.map((c) => `<span class="chip ${c.count ? "warn" : "gray"} link" data-drill='${esc(JSON.stringify({ scope: "checks", acr_type: ["R"], code: c.code }))}'>${esc(c.label)} ${c.count}건</span>`).join("")}</div>
      ${funnelTable(d.checks, { priority: true, maxH: 520 })}
      <p class="desc" style="margin-top:6px">재계약 성공률·고객 유지율은 대상 집단과 결과 정의가 확인되지 않아 산출하지 않습니다.</p></div>
    ${basisBlock(d.basis)}${rulesBlock(d.rules)}`;
    $("view").innerHTML = h;
    const cls = d.change.filter((c) => c.class !== "미확인");
    chart("chgChart", {
      type: "bar",
      data: { labels: cls.map((c) => c.class), datasets: [
        { label: "기존 월매출", data: cls.map((c) => conv(c.prev)), backgroundColor: "#94a3b8", borderRadius: 3, maxBarThickness: 28 },
        { label: "변경 월매출", data: cls.map((c) => conv(c.new)), backgroundColor: COLORS.R, borderRadius: 3, maxBarThickness: 28 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: tooltipAmt } } }, scales: { y: { title: { display: true, text: `월매출 (${unitName()})` }, grid: zeroGrid }, x: { grid: { display: false } } } },
    });
  }

  // ------------------------------------------------------------ 페이지: ACR 수주
  async function pageAcr() {
    const j = await api("/view/acr", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const t = d.totals, ser = S.ui.acrSeries;
    const term = d.mode === "term";
    const lbl = term ? "기간 합계(월별 추정값 합)" : "매출개시월 기준 합계";
    const orgRows = S.f.level === "am" ? d.by_am : d.by_team;
    // 누적매출 = 조회기간 합계(기준·기간을 카드 아래에 표기)
    const kb = esc(`${lbl} · ${S.f.ym_from}~${S.f.ym_to}`);
    let h = `<div class="notice info"><b>${esc(d.mode_label)}</b> — ${esc(d.basis["주의"])}</div>
    <div class="grid kpis">
      ${kpiCard("A. 누적매출", amt(t.A), `Funnel ${cnt(t.funnels_A)}건<br>${kb}`, "a", { scope: "acr", acr_type: ["A"] })}
      ${kpiCard("C. 누적매출", amt(t.C), `Funnel ${cnt(t.funnels_C)}건<br>${kb}`, "c", { scope: "acr", acr_type: ["C"] })}
      ${kpiCard("R. 누적매출", amt(t.R), `Funnel ${cnt(t.funnels_R)}건 (재계약 증감)<br>${kb}`, "r", { scope: "acr", acr_type: ["R"] })}
      ${kpiCard("A+C. 누적매출", amt(t.AC), `Funnel ${cnt(t.funnels_A + t.funnels_C)}건<br>${kb}`, "", { scope: "acr", acr_type: ["A", "C"] })}
      ${kpiCard("A+C+R. 누적매출", amt(t.ACR), `고유 Funnel ${cnt(t.funnels)}건<br>${kb}`, "", { scope: "acr" })}
      ${kpiCard("고유 Funnel 건수", cnt(t.funnels) + "건", "월별 반복 반영 횟수 아님", "", { scope: "acr" })}
    </div>
    ${Object.keys(d.excluded).length ? `<div class="notice warn">확정 조건이지만 이 지표에서 제외: ${Object.entries(d.excluded).map(([r, n]) => `${esc(r)} ${n}건`).join(", ")} <span class="link" data-drill='${esc(JSON.stringify({ scope: "acr_excluded" }))}'>목록 보기</span></div>` : ""}
    <div class="card" style="margin-top:14px"><div class="card-head"><h3>월별 ${term ? "증감 추정" : "ACR 월매출 증감액"}</h3>
      <div class="legend" id="serSel">${["A", "C", "R", "AC", "ACR"].map((k) => `<label><input type="checkbox" value="${k}" ${ser.includes(k) ? "checked" : ""}><i style="background:${COLORS[k]}"></i>${SERIES_LABEL[k]}</label>`).join("")}</div></div>
      <p class="desc">막대=A·C·R, 선=합산 · 단위 ${esc(unitName())} · 0 기준선 아래는 감액 · 클릭 → 해당 월 Funnel</p>
      <div class="chart-box tall"><canvas id="acrChart"></canvas></div></div>
    <div class="card" style="margin-top:14px"><h3>누적 (${esc(d.basis["누적"])})</h3><p class="desc">월별 금액과 축을 분리한 별도 차트 · 단위 ${esc(unitName())}</p><div class="chart-box"><canvas id="cumChart"></canvas></div></div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>팀별 비교</h3><p class="desc">${esc(lbl)} · 단위 ${esc(unitName())}</p><div class="chart-box"><canvas id="teamChart"></canvas></div></div>
      <div class="card"><h3>AM별 비교 (A+C+R 상위 20)</h3><p class="desc">${esc(lbl)}</p><div class="chart-box tall"><canvas id="amChart"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>월별 표</h3><div class="table-wrap"><table class="t"><thead><tr><th>년월</th><th class="num">A</th><th class="num">C</th><th class="num">R</th><th class="num">A+C</th><th class="num">A+C+R</th><th class="num">누적 A+C+R</th><th class="num">고유 Funnel</th></tr></thead>
      <tbody>${d.monthly.map((m) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ scope: "acr", ym: m.ym }))}'><td>${m.label}</td><td class="num">${amt(m.A)}</td><td class="num">${amt(m.C)}</td><td class="num">${amt(m.R)}</td><td class="num">${amt(m.AC)}</td><td class="num"><b>${amt(m.ACR)}</b></td><td class="num">${amt(m.cum.ACR)}</td><td class="num">${cnt(m.funnels)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>${term ? "기간 합계" : "합계"}</td><td class="num">${amt(t.A)}</td><td class="num">${amt(t.C)}</td><td class="num">${amt(t.R)}</td><td class="num">${amt(t.AC)}</td><td class="num">${amt(t.ACR)}</td><td></td><td class="num">${cnt(t.funnels)} (고유)</td></tr></tfoot></table></div></div>
    <div class="card" style="margin-top:14px"><h3>조직별 표 (${S.f.level === "am" ? "AM" : "팀"})</h3><p class="desc">집계 수준 ‘AM’ 선택 시 AM별 · 조직별 합계는 담당 전체와 일치</p>
      <div class="table-wrap" style="max-height:520px"><table class="t"><thead><tr><th>${S.f.level === "am" ? "AM(팀)" : "팀"}</th><th class="num">A</th><th class="num">C</th><th class="num">R</th><th class="num">A+C</th><th class="num">A+C+R</th><th class="num">고유 Funnel</th><th class="num">R 음수 건수</th><th class="num">R 음수 금액</th></tr></thead>
      <tbody>${orgRows.map((r) => `<tr class="clickable" data-drill='${esc(JSON.stringify(S.f.level === "am" ? { scope: "acr", am_key: r.key } : { scope: "acr", team: r.key }))}'><td>${esc(r.am ? `${r.am} (${r.team})` : r.team)}</td><td class="num">${amt(r.A)}</td><td class="num">${amt(r.C)}</td><td class="num">${amt(r.R)}</td><td class="num">${amt(r.AC)}</td><td class="num"><b>${amt(r.ACR)}</b></td><td class="num">${cnt(r.funnels)}</td><td class="num">${cnt(r.r_neg_count)}</td><td class="num">${amt(r.r_neg_amount)}</td></tr>`).join("") || '<tr><td colspan="9" class="muted">자료 없음</td></tr>'}</tbody></table></div></div>
    ${basisBlock(d.basis)}`;
    $("view").innerHTML = h;
    acrMonthlyChart("acrChart", d.monthly, ser, (m, key) => openDetail({ scope: "acr", ym: m.ym, acr_type: key && ["A", "C", "R"].includes(key) ? [key] : undefined }));
    const cumDs = ser.map((k) => ({ label: `누적 ${SERIES_LABEL[k]}`, data: d.monthly.map((m) => conv(m.cum[k])), borderColor: COLORS[k], backgroundColor: COLORS[k], borderWidth: 2, pointRadius: 2, tension: 0 }));
    chart("cumChart", { type: "line", data: { labels: d.monthly.map((m) => m.label), datasets: cumDs },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: tooltipAmt } } }, scales: { y: { title: { display: true, text: `누적 금액 (${unitName()})` }, grid: zeroGrid }, x: { grid: { display: false } } } } });
    const orgBar = (id, rows, labelFn, horizontal) => {
      const dsets = ["A", "C", "R"].map((k) => ({ label: k, data: rows.map((r) => conv(r[k])), backgroundColor: COLORS[k], borderRadius: 2, maxBarThickness: 16 }));
      chart(id, { type: "bar", data: { labels: rows.map(labelFn), datasets: dsets },
        options: { indexAxis: horizontal ? "y" : "x", maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtNum(horizontal ? ctx.parsed.x : ctx.parsed.y).replace(/<[^>]+>/g, "")}` } } },
          scales: horizontal ? { x: { title: { display: true, text: unitName() }, grid: zeroGrid }, y: { grid: { display: false }, ticks: { autoSkip: false } } } : { y: { title: { display: true, text: unitName() }, grid: zeroGrid }, x: { grid: { display: false } } },
          onClick: (e, els) => { if (els.length) { const r = rows[els[0].index]; openDetail(r.am ? { scope: "acr", am_key: r.key } : { scope: "acr", team: r.key }); } } } });
    };
    orgBar("teamChart", d.by_team, (r) => r.team, false);
    orgBar("amChart", d.by_am.slice(0, 20), (r) => `${r.am} (${r.team})`, true);
    document.querySelectorAll("#serSel input").forEach((i) => i.addEventListener("change", () => {
      S.ui.acrSeries = Array.from(document.querySelectorAll("#serSel input:checked")).map((x) => x.value);
      store.set("ui", S.ui); render();
    }));
  }

  // ------------------------------------------------------------ 페이지: ACR 수주(Pre-sales)
  async function pagePresales() {
    const j = await api("/view/presales", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const tab = ["A", "C", "R"].includes(S.ui.psTab) ? S.ui.psTab : "A";
    const T = d.types[tab], tt = T.totals, isR = tab === "R";
    const per = `${S.f.ym_from}~${S.f.ym_to}`;
    const dObj = (extra) => Object.assign({ scope: "in_progress", acr_type: [tab], period: "rev_ym" }, extra || {});
    const drill = (extra) => esc(JSON.stringify(dObj(extra)));
    const sm = d.summary;
    // 월별 ACR 수주 증감액(Pre-sales) — 가능성 5개 묶음(겹치지 않음) 막대 + 합계 선
    const PSG = [["30%이하", ["30%이하"], "--pb-1"], ["30%이상", ["30%이상", "40%이상"], "--pb-2"], ["50%이상", ["50%이상", "60%이상"], "--pb-3"],
      ["70%이상", ["70%이상", "80%이상"], "--pb-4"], ["90%이상", ["90%이상", "100%이상"], "--pb-5"]];
    const pct_ = ["ALL", "A", "C", "R"].includes(S.ui.psChartType) ? S.ui.psChartType : "ALL";
    const cTypes = pct_ === "ALL" ? ["A", "C", "R"] : [pct_];
    const psSer = Array.isArray(S.ui.psSeries) ? S.ui.psSeries : PSG.map((g) => g[0]).concat(["합계"]);
    const mons = d.types.A.monthly.map((m) => ({ ym: m.ym, label: m.label }));
    const gsum = (i, bands) => cTypes.reduce((a, t) => a + bands.reduce((x, b) => x + (d.types[t].monthly[i].bands[b] || 0), 0), 0);
    const gData = PSG.map(([lb, bands]) => mons.map((m, i) => gsum(i, bands)));
    const totData = mons.map((m, i) => gData.reduce((a, g) => a + g[i], 0));
    const unk = mons.reduce((a, m, i) => a + gsum(i, ["미확인"]), 0);
    let h = `<div class="card"><div class="card-head"><h3>월별 ACR 수주 증감액 (Pre-sales)</h3>
        <div class="legend" id="psSerSel">${PSG.map(([lb, , tok]) => `<label><input type="checkbox" value="${lb}" ${psSer.includes(lb) ? "checked" : ""}><i style="background:${css(tok, "#3a7fd0")}"></i>${lb}</label>`).join("")}
          <label><input type="checkbox" value="합계" ${psSer.includes("합계") ? "checked" : ""}><i style="background:${COLORS.ACR}"></i>합계</label></div></div>
      <div class="toolbar" style="margin:4px 0 6px"><span class="seg-light" id="psTypeSel">${[["ALL", "A+C+R"], ["A", "A"], ["C", "C"], ["R", "R"]].map(([k, l]) => `<button type="button" data-v="${k}" class="${k === pct_ ? "on" : ""}">${l}</button>`).join("")}</span>
        <span class="muted">진행 중(Pre Sales·제안완료) · 매출발생년월 기준 · 막대=가능성 구간, 선=합계 · 단위 ${esc(unitName())} · 클릭 → 해당 월·구간 Funnel</span></div>
      <p class="desc">30%이하=0~29%, 30%이상=30~49%, 50%이상=50~69%, 70%이상=70~89%, 90%이상=90~100%.${unk ? ` 가능성 미확인 ${fmtNum(conv(unk)).replace(/<[^>]+>/g, "")}은 차트에서 제외.` : ""}</p>
      <div class="chart-box tall"><canvas id="psMonthChart"></canvas></div></div>
    <div style="height:14px"></div>`;
    h += `<div class="tabs" role="tablist">${["A", "C", "R"].map((k) => `<button data-pstab="${k}" class="${k === tab ? "on" : ""}" type="button" role="tab">${k} 매출 <span class="muted">${cnt(sm[k].count)}건 · ${amt(sm[k].monthly)}</span></button>`).join("")}</div>
    <div class="grid kpis">
      ${kpiCard(`${tab}. 진행 중 건수`, cnt(tt.count) + "건", `Pre Sales·제안완료 · 매출발생년월 ${esc(per)}`, tab.toLowerCase(), dObj())}
      ${kpiCard(`${tab}. 예상매출(~${String(S.f.ym_to).slice(2, 4)}년)`, amt(tt.monthly), "", tab.toLowerCase(), dObj())}
      ${isR ? kpiCard("R. 기존 → 변경 월매출", `${amt(tt.prev)}`, `변경 ${amt(tt.new)}`, "r", dObj())
            : kpiCard(`${tab}. 계약기간매출`, amt(tt.contract), "진행 중 Funnel의 계약금액(원본)", tab.toLowerCase(), dObj())}
      ${kpiCard(`${tab}. 가중 추정(참고)`, amt(tt.weighted), "월매출 × 입력 가능성(%) · 미확인 제외", "", dObj())}
    </div>
    ${T.excluded.rev_ym_missing || T.excluded.out_of_period ? `<div class="notice warn">조회기간 기준에서 제외된 진행 중 ${tab} 건: 매출발생년월 미입력 ${T.excluded.rev_ym_missing}건, 조회기간 밖 ${T.excluded.out_of_period}건</div>` : ""}
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="card-head"><h3>${tab} 수주${isR ? "(재계약)" : ""} 가능성 구간별 예상 월매출</h3><span class="muted">막대 클릭 → 해당 구간 Funnel</span></div>
        <p class="desc">구간 금액(막대) · 단위 ${esc(unitName())} · 0 기준선 아래는 감액</p>
        <div class="chart-box"><canvas id="psChart"></canvas></div></div>
      <div class="card"><h3>구간별 건수</h3><p class="desc">상태별(Pre Sales / 제안완료) 건수</p><div class="chart-box"><canvas id="psCntChart"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>${tab} 가능성 구간표</h3>
      <p class="desc">30%이하 = 0~29%, 30%이상 = 30~39% … 90%이상 = 90~99%, 100%이상 = 100%. ‘해당 % 이상 누적’은 그 구간부터 100%까지의 합입니다. 행 클릭 → Funnel 목록</p>
      <div class="table-wrap"><table class="t"><thead><tr><th>가능성 구간</th><th class="num">건수</th><th class="num">Pre Sales</th><th class="num">제안완료</th><th class="num">예상 월매출</th>
        ${isR ? '<th class="num">기존 월매출</th><th class="num">변경 월매출</th>' : '<th class="num">계약기간매출</th>'}<th class="num">가중 추정</th><th class="num">해당 % 이상 누적 건수</th><th class="num">해당 % 이상 누적 월매출</th></tr></thead>
      <tbody>${T.bins.map((b) => `<tr class="clickable" data-drill='${drill({ prob_band: b.band })}'><td><b>${esc(b.band)}</b></td><td class="num">${cnt(b.count)}</td><td class="num">${cnt(b.presales)}</td><td class="num">${cnt(b.proposal)}</td>
        <td class="num">${amt(b.monthly)}</td>${isR ? `<td class="num">${amt(b.prev)}</td><td class="num">${amt(b.new)}</td>` : `<td class="num">${amt(b.contract)}</td>`}
        <td class="num">${b.weighted == null ? '<span class="muted">산출 불가</span>' : amt(b.weighted)}</td>
        <td class="num">${b.cum_count == null ? '<span class="muted">-</span>' : cnt(b.cum_count)}</td><td class="num">${b.cum_monthly == null ? '<span class="muted">-</span>' : amt(b.cum_monthly)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>합계</td><td class="num">${cnt(tt.count)}</td><td class="num">${cnt(T.bins.reduce((a, b) => a + b.presales, 0))}</td><td class="num">${cnt(T.bins.reduce((a, b) => a + b.proposal, 0))}</td><td class="num">${amt(tt.monthly)}</td>
        ${isR ? `<td class="num">${amt(tt.prev)}</td><td class="num">${amt(tt.new)}</td>` : `<td class="num">${amt(tt.contract)}</td>`}<td class="num">${amt(tt.weighted)}</td><td></td><td></td></tr></tfoot></table></div></div>
    <details class="card" style="margin-top:14px"><summary><b>${tab} 월별(매출발생년월) × 가능성 구간</b> <span class="muted">(펼치기)</span></summary>
      <div class="table-wrap" style="margin-top:8px;max-height:520px"><table class="t"><thead><tr><th>년월</th><th class="num">건수</th>${d.bands.concat(["미확인"]).map((b) => `<th class="num">${esc(b)}</th>`).join("")}<th class="num">합계</th></tr></thead>
      <tbody>${T.monthly.filter((m) => m.count).map((m) => `<tr><td>${m.label}</td><td class="num">${cnt(m.count)}</td>${d.bands.concat(["미확인"]).map((b) => `<td class="num">${m.bands[b] ? amt(m.bands[b]) : '<span class="muted">-</span>'}</td>`).join("")}<td class="num"><b>${amt(m.total)}</b></td></tr>`).join("") || '<tr><td colspan="13" class="muted">해당 없음</td></tr>'}</tbody></table></div></details>
    <div class="card" style="margin-top:14px"><h3>유형별 요약</h3><div class="table-wrap"><table class="t"><thead><tr><th>유형</th><th class="num">진행 중 건수</th><th class="num">예상 월매출</th><th class="num">계약기간매출</th><th class="num">기존 월매출</th><th class="num">변경 월매출</th><th class="num">가중 추정</th></tr></thead>
      <tbody>${["A", "C", "R"].map((k) => `<tr class="clickable" data-pstab="${k}"><td>${typeTag(k)}</td><td class="num">${cnt(sm[k].count)}</td><td class="num">${amt(sm[k].monthly)}</td><td class="num">${amt(sm[k].contract)}</td><td class="num">${k === "R" ? amt(sm[k].prev) : '<span class="muted">-</span>'}</td><td class="num">${k === "R" ? amt(sm[k].new) : '<span class="muted">-</span>'}</td><td class="num">${amt(sm[k].weighted)}</td></tr>`).join("")}</tbody></table></div>
      <p class="desc" style="margin-top:6px">진행 중 기회의 현재 입력값입니다. 확정 ACR(누적매출)과 합산하지 않습니다.</p></div>
    ${basisBlock(d.basis)}`;
    $("view").innerHTML = h;
    document.querySelectorAll("[data-pstab]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); S.ui.psTab = b.dataset.pstab; store.set("ui", S.ui); render(); }));
    const visG = PSG.map((g, i) => [g, i]).filter(([g]) => psSer.includes(g[0]));
    const mds = visG.map(([g, i]) => ({ type: "bar", label: g[0], bands: g[1], data: gData[i].map(conv), backgroundColor: css(g[2], "#3a7fd0"), borderRadius: 3, maxBarThickness: 14, order: 2 }));
    if (psSer.includes("합계")) mds.push({ type: "line", label: "합계", bands: PSG.flatMap((g) => g[1]), data: totData.map(conv), borderColor: COLORS.ACR, backgroundColor: COLORS.ACR, borderWidth: 2, pointRadius: 3, tension: 0, order: 1 });
    chart("psMonthChart", { data: { labels: mons.map((m) => m.label), datasets: mds },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: tooltipAmt } } },
        scales: { y: { title: { display: true, text: `월별 금액 (${unitName()})` }, grid: zeroGrid }, x: { grid: { display: false } } },
        onClick: (evt, els, c) => {
          const pts = c.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
          if (!pts.length) return;
          const near = c.getElementsAtEventForMode(evt, "nearest", { intersect: true }, false);
          const bands = near.length ? c.data.datasets[near[0].datasetIndex].bands : PSG.flatMap((g) => g[1]);
          openDetail({ scope: "in_progress", acr_type: cTypes, period: "rev_ym", rev_month: mons[pts[0].index].ym, prob_band: bands });
        } } });
    document.querySelectorAll("#psSerSel input").forEach((i) => i.addEventListener("change", () => {
      S.ui.psSeries = Array.from(document.querySelectorAll("#psSerSel input:checked")).map((x) => x.value); store.set("ui", S.ui); render(); }));
    document.querySelectorAll("#psTypeSel button").forEach((b) => b.addEventListener("click", () => { S.ui.psChartType = b.dataset.v; store.set("ui", S.ui); render(); }));
    const labels = T.bins.map((b) => b.band);
    chart("psChart", { type: "bar",
      data: { labels, datasets: [{ label: `${tab} 예상 월매출`, data: T.bins.map((b) => conv(b.monthly || 0)), backgroundColor: COLORS[tab], borderRadius: 3, maxBarThickness: 34 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltipAmt } } },
        scales: { y: { title: { display: true, text: `월매출 (${unitName()})` }, grid: zeroGrid }, x: { grid: { display: false } } },
        onClick: (e, els) => { if (els.length) openDetail({ scope: "in_progress", acr_type: [tab], period: "rev_ym", prob_band: labels[els[0].index] }); } } });
    chart("psCntChart", { type: "bar",
      data: { labels, datasets: [
        { label: "Pre Sales", data: T.bins.map((b) => b.presales), backgroundColor: COLORS[tab], borderRadius: 2, maxBarThickness: 34, stack: "s" },
        { label: "제안완료", data: T.bins.map((b) => b.proposal), backgroundColor: COLORS.ACR, borderRadius: 2, maxBarThickness: 34, stack: "s" }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" } },
        scales: { y: { stacked: true, title: { display: true, text: "건수" }, grid: zeroGrid, ticks: { precision: 0 } }, x: { stacked: true, grid: { display: false } } },
        onClick: (e, els) => { if (els.length) openDetail({ scope: "in_progress", acr_type: [tab], period: "rev_ym", prob_band: labels[els[0].index] }); } } });
  }

  // ------------------------------------------------------------ 페이지: ACR 수주(총액)
  async function pageTotal() {
    const j = await api("/view/total", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const t = d.totals, y = d.year, rf = d.r_ref;
    const years = Array.from(new Set((S.meta.options.years || []).concat([y]))).sort((a, b) => a - b);
    const kb = esc(`수주년월 ${y}-01~${y}-12 · 계약기간매출 합계`);
    const dk = (extra) => Object.assign({ scope: "total" }, extra || {});
    const orgRows = S.f.level === "am" ? d.by_am : d.by_team;
    let h = `<div class="toolbar"><span class="muted">집계연도</span><span class="seg-light" id="tyearSel">${years.map((yy) => `<button type="button" data-v="${yy}" class="${yy === y ? "on" : ""}">${yy}년</button>`).join("")}</span>
        <span class="muted">확정 건(A·C=Win, R=재계약완료)의 계약 전체 기간 매출을 수주월에 합산 · 단위 ${esc(unitName())}</span></div>
    <div class="grid kpis">
      ${kpiCard("A. 총액", amt(t.A), `Funnel ${cnt(t.funnels_A)}건<br>${kb}`, "a", dk({ acr_type: ["A"] }))}
      ${kpiCard("C. 총액", amt(t.C), `Funnel ${cnt(t.funnels_C)}건<br>${kb}`, "c", dk({ acr_type: ["C"] }))}
      ${kpiCard("R. 총액", amt(t.R), `Funnel ${cnt(t.funnels_R)}건 (재계약 증감 총액)<br>${kb}`, "r", dk({ acr_type: ["R"] }))}
      ${kpiCard("A+C. 총액", amt(t.AC), `Funnel ${cnt(t.funnels_A + t.funnels_C)}건<br>${kb}`, "", dk({ acr_type: ["A", "C"] }))}
      ${kpiCard("A+C+R. 총액", amt(t.ACR), `Funnel ${cnt(t.funnels)}건<br>${kb}`, "", dk())}
    </div>
    ${Object.keys(d.excluded).length ? `<div class="notice warn">총액에서 제외: ${Object.entries(d.excluded).map(([k, v]) => `${esc(k)} ${v}건`).join(", ")}</div>` : ""}
    ${d.mismatch ? `<div class="notice warn">계약기간매출이 월매출합계 × 계약기간과 다른 건 ${d.mismatch}건 — 원본 계약기간매출 그대로 합산했습니다.</div>` : ""}
    <div class="card" style="margin-top:14px"><div class="card-head"><h3>월별 ACR 총액 (수주월 기준, ${y}년)</h3><span class="muted">막대 A·C·R, 선 A+C+R · 클릭 → 해당 월 Funnel</span></div>
      <p class="desc">각 건의 계약기간매출을 수주년월에 한 번 배치 · 단위 ${esc(unitName())} · 0 기준선 아래는 R 감액</p>
      <div class="chart-box tall"><canvas id="totChart"></canvas></div></div>
    <div class="card" style="margin-top:14px"><h3>월별 표</h3><div class="table-wrap"><table class="t"><thead><tr><th>수주년월</th><th class="num">A</th><th class="num">C</th><th class="num">R</th><th class="num">A+C</th><th class="num">A+C+R</th><th class="num">누적 A+C+R</th><th class="num">건수</th></tr></thead>
        <tbody>${d.monthly.map((m) => `<tr class="clickable" data-drill='${esc(JSON.stringify(dk({ win_month: m.ym })))}'><td>${m.label}</td><td class="num">${amt(m.A)}</td><td class="num">${amt(m.C)}</td><td class="num">${amt(m.R)}</td><td class="num">${amt(m.AC)}</td><td class="num"><b>${amt(m.ACR)}</b></td><td class="num">${amt(m.cum_ACR)}</td><td class="num">${cnt(m.funnels)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>${y}년 합계</td><td class="num">${amt(t.A)}</td><td class="num">${amt(t.C)}</td><td class="num">${amt(t.R)}</td><td class="num">${amt(t.AC)}</td><td class="num">${amt(t.ACR)}</td><td></td><td class="num">${cnt(t.funnels)}</td></tr></tfoot></table></div></div>
      <div class="card" style="margin-top:14px"><h3>R 재계약 총액 참고</h3><p class="desc">재계약완료 ${cnt(rf.count)}건 · 증액 ${cnt(rf.increase_count)} / 동일 ${cnt(rf.same_count)} / 감액 ${cnt(rf.decrease_count)}건</p>
        <div class="table-wrap"><table class="t"><tbody>
          <tr><td>기존 계약총액 (기존매출 × 계약기간)</td><td class="num">${amt(rf.prev_total)}</td></tr>
          <tr><td>재계약 후 계약총액 (변경매출 × 계약기간)</td><td class="num">${amt(rf.new_total)}</td></tr>
          <tr><td><b>R. 총액 (증감 = 계약기간매출 합계)</b></td><td class="num"><b>${amt(t.R)}</b></td></tr></tbody></table></div>
        <p class="desc" style="margin-top:6px">R. 총액은 재계약으로 늘거나 줄어든 금액의 계약기간 합계입니다. 재계약 후 계약총액은 참고용이며 A+C+R 합계에 넣지 않습니다.</p></div>
    <div class="card" style="margin-top:14px"><h3>조직별 (${S.f.level === "am" ? "AM" : "팀"})</h3><p class="desc">사이드바 ‘집계 수준’을 AM으로 바꾸면 AM별 · 조직별 합계 = 담당 전체</p>
      <div class="table-wrap" style="max-height:520px"><table class="t"><thead><tr><th>${S.f.level === "am" ? "AM(팀)" : "팀"}</th><th class="num">A</th><th class="num">C</th><th class="num">R</th><th class="num">A+C</th><th class="num">A+C+R</th><th class="num">건수</th><th class="num">R 감액 건수</th></tr></thead>
      <tbody>${orgRows.map((r) => `<tr class="clickable" data-drill='${esc(JSON.stringify(dk(S.f.level === "am" ? { am_key: r.key } : { team: r.key })))}'><td>${esc(r.am ? `${r.am} (${r.team})` : r.team)}</td><td class="num">${amt(r.A)}</td><td class="num">${amt(r.C)}</td><td class="num">${amt(r.R)}</td><td class="num">${amt(r.AC)}</td><td class="num"><b>${amt(r.ACR)}</b></td><td class="num">${cnt(r.funnels)}</td><td class="num">${cnt(r.r_neg_count)}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">자료 없음</td></tr>'}</tbody>
      <tfoot><tr><td>담당 합계</td><td class="num">${amt(t.A)}</td><td class="num">${amt(t.C)}</td><td class="num">${amt(t.R)}</td><td class="num">${amt(t.AC)}</td><td class="num">${amt(t.ACR)}</td><td class="num">${cnt(t.funnels)}</td><td></td></tr></tfoot></table></div></div>
    ${basisBlock(d.basis)}`;
    $("view").innerHTML = h;
    acrMonthlyChart("totChart", d.monthly, ["A", "C", "R", "ACR"], (m, key) => openDetail(dk({ win_month: m.ym, acr_type: key && ["A", "C", "R"].includes(key) ? [key] : undefined })));
    document.querySelectorAll("#tyearSel button").forEach((b) => b.addEventListener("click", () => { S.f.total_year = Number(b.dataset.v); store.set("filters", S.f); render(); }));
  }

  // ------------------------------------------------------------ 페이지: 팀·AM
  async function pageTeam() {
    const f = Object.assign({}, S.f, { level: S.f.level === "am" ? "am" : "team" });
    const j = await api("/view/team", { filters: f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const isAm = d.level === "am";
    const dk = (r, extra) => JSON.stringify(Object.assign(isAm ? { am_key: r.key } : { team: r.key }, extra));
    const C = (r, v, extra, isAmt) => `<td class="num"><span class="link" data-drill='${esc(dk(r, extra))}'>${isAmt ? amt(v) : cnt(v)}</span></td>`;
    const sum = (k) => d.rows.reduce((a, r) => a + (r[k] || 0), 0);
    let h = `<div class="notice info">집계 수준: <b>${isAm ? "AM" : "팀"}</b> (사이드바 ‘집계 수준’에서 AM 선택 시 AM별). 매출 순위와 확인 과제를 함께 보며, 목표·보유고객 자료가 없어 자동 성과등급은 만들지 않습니다.</div>
    <div class="card"><div class="table-wrap" style="max-height:640px"><table class="t"><thead><tr>
      <th>${isAm ? "AM(팀)" : "팀"}</th><th class="num" title="조회기간 확정 A/C 월매출 증감액 합계">A/C 누적매출</th><th class="num">진행 중 A/C</th><th class="num" title="현재상황 Pre Sales·제안완료인 A/C의 계약기간매출 합계">Pre Sales/제안완료 계약기간 매출</th><th class="num">예정 임박</th><th class="num">예정월 경과</th>
      <th class="num">Win 건수</th><th class="num">Win 계약기간매출</th><th class="num">진행 중 재계약</th><th class="num">재계약 기존 월매출</th><th class="num">재계약 감액(완료)</th><th class="num">감액 예상(진행)</th>
      <th class="num">해지확정</th><th class="num">장기 미갱신</th><th class="num">갱신일 미입력</th><th class="num">필수정보 누락·오류</th><th class="num">확인 Funnel(높음)</th></tr></thead>
      <tbody>${d.rows.map((r) => `<tr><td>${esc(isAm ? `${r.am} (${r.team})` : r.team)}</td>
        <td class="num"><span class="link" data-drill='${esc(dk(r, { scope: "acr", acr_type: ["A", "C"] }))}'>${amt(r.acr_ac)}</span></td>
        ${C(r, r.prog_ac_count, { scope: "in_progress", acr_type: ["A", "C"] })}<td class="num">${amt(r.prog_ac_amount)}</td>
        ${C(r, r.imminent, { scope: "in_progress", imminent: true })}${C(r, r.overdue, { scope: "in_progress", bucket: "예정월 경과" })}
        ${C(r, r.win_count, { acr_type: ["A", "C"], status: ["Win"], period: "win_ym" })}<td class="num">${amt(r.win_amount)}</td>
        ${C(r, r.prog_r_count, { scope: "in_progress", acr_type: ["R"] })}<td class="num">${amt(r.prog_r_prev)}</td>
        ${C(r, r.renewal_decrease_done, { acr_type: ["R"], status: ["재계약완료"], period: "win_ym", change: "감액" })}
        ${C(r, r.renewal_decrease_expected, { scope: "checks", code: "RENEWAL_DECREASE" })}
        ${C(r, r.churn, { acr_type: ["R"], status: ["해지확정"], period: "win_ym" })}
        ${C(r, r.stale, { scope: "checks", code: "STALE" })}${C(r, r.update_missing, { scope: "checks", code: "UPDATE_MISSING" })}
        ${C(r, r.missing_info, { scope: "quality" })}
        <td class="num"><span class="link" data-drill='${esc(dk(r, { scope: "checks" }))}'>${cnt(r.check_funnels)}</span> <span class="muted">(${cnt(r.check_level1)})</span></td></tr>`).join("")}</tbody>
      <tfoot><tr><td>합계</td><td class="num">${amt(sum("acr_ac"))}</td><td class="num">${cnt(sum("prog_ac_count"))}</td><td class="num">${amt(sum("prog_ac_amount"))}</td><td class="num">${cnt(sum("imminent"))}</td><td class="num">${cnt(sum("overdue"))}</td><td class="num">${cnt(sum("win_count"))}</td><td class="num">${amt(sum("win_amount"))}</td><td class="num">${cnt(sum("prog_r_count"))}</td><td class="num">${amt(sum("prog_r_prev"))}</td><td class="num">${cnt(sum("renewal_decrease_done"))}</td><td class="num">${cnt(sum("renewal_decrease_expected"))}</td><td class="num">${cnt(sum("churn"))}</td><td class="num">${cnt(sum("stale"))}</td><td class="num">${cnt(sum("update_missing"))}</td><td class="num">${cnt(sum("missing_info"))}</td><td class="num">${cnt(sum("check_funnels"))}</td></tr></tfoot></table></div>
      <p class="desc" style="margin-top:6px">숫자를 클릭하면 해당 조건의 Funnel 목록으로 이동합니다. ‘확인 Funnel’ 괄호 안은 높음 등급 건수.</p></div>
    ${basisBlock(d.basis)}${rulesBlock(d.rules)}`;
    $("view").innerHTML = h;
  }

  // ------------------------------------------------------------ 페이지: AM 성과·활동 점검
  async function pagePerf() {
    const j = await api("/view/perf", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const t = d.total, y = d.year, isAm = d.level === "am", mn = d.min_sample;
    const years = Array.from(new Set((S.meta.options.years || []).concat([y]))).sort((a, b) => a - b);
    const nf = (v) => Number(v).toLocaleString("ko-KR");
    // 건수 비율: 표본 기준 이상이면 비율(분자/분모), 미만이면 '표본 부족(분자/분모)'
    const fr = (r) => (r.rate == null ? '<span class="muted">-</span>' : r.ok ? `<b>${pct(r.rate)}</b> <span class="muted">(${nf(r.num)}/${nf(r.den)})</span>` : `<span class="muted" title="분모 ${mn}건 미만">표본 부족 (${nf(r.num)}/${nf(r.den)})</span>`);
    // 금액 비율: 표본 기준은 같은 대상의 건수로 판정
    const fa = (r) => (r.rate == null ? '<span class="muted">-</span>' : r.ok ? `<b>${pct(r.rate)}</b>` : `<span class="muted" title="건수 ${mn}건 미만">표본 부족 (${pct(r.rate).replace(/<[^>]+>/g, "")})</span>`);
    const orgD = (r) => (isAm ? { am_key: r.key } : { team: r.key });
    const lk = (n, drill) => (n ? `<span class="link" data-drill='${esc(JSON.stringify(drill))}'>${nf(n)}</span>` : '<span class="muted">0</span>');
    const dW = (o, extra) => Object.assign({ acr_type: ["A", "C"], status: ["Win"], win_year: y }, o, extra || {});
    const dS = (o, st, extra) => Object.assign({ acr_type: ["A", "C"], status: [st], win_year: y }, o, extra || {});
    const dR = (o, st) => Object.assign({ acr_type: ["R"], status: [st], win_year: y }, o);
    const perfRow = (r, label, o) => `<tr><td>${label}</td>
      <td class="num">${lk(r.AC.win, dW(o))} <span class="muted">(사전 ${lk(r.AC.win_pre, dW(o, { reg_type: "사전" }))} / 사후 ${lk(r.AC.win_post, dW(o, { reg_type: "사후·당일" }))})</span></td>
      <td class="num">${lk(r.AC.lose, dS(o, "Lose"))}</td><td class="num">${lk(r.AC.drop, dS(o, "Drop"))}</td>
      <td class="num">${fr(r.AC.simple)}</td><td class="num">${fr(r.AC.pre)}</td><td class="num">${fr(r.A.pre)}</td><td class="num">${fr(r.C.pre)}</td>
      <td class="num">${lk(r.r_done, dR(o, "재계약완료"))}</td><td class="num">${lk(r.r_churn, dR(o, "해지확정"))}</td>
      <td class="num">${fr(r.ret_cnt)}</td><td class="num">${fa(r.ret_amt)}</td><td class="num">${fa(r.chg_rate)}</td>
      <td class="wrap">${esc(r.churn_top || "-")}</td><td class="num">${fr(r.new_share)}</td></tr>`;
    const actRow = (r, label, o) => `<tr><td>${label}</td>
      <td class="num">${lk(r.prog, Object.assign({ scope: "in_progress" }, o))}</td><td class="num">${fr(r.fresh30)}</td>
      <td class="num">${lk(r.stale_long, Object.assign({ scope: "checks", code: "STALE_LONG" }, o))}</td>
      <td class="num">${lk(r.long_stay, Object.assign({ scope: "checks", code: "LONG_STAY" }, o))}</td>
      <td class="num">${fr(r.AC.reg)}</td><td class="num">${r.lead_median == null ? '<span class="muted">-</span>' : nf(r.lead_median) + "일"}</td>
      <td class="num">${fr(r.overconf)} ${r.overconf.num ? lk(r.overconf.num, dS(o, "Lose", { lose_overconf: true })) + "건" : ""}</td></tr>`;
    const orgLabel = (r) => esc(r.am ? `${r.am} (${r.team})` : r.team);
    let h = `<div class="toolbar"><span class="muted">집계연도(성과)</span><span class="seg-light" id="pyearSel">${years.map((yy) => `<button type="button" data-v="${yy}" class="${yy === y ? "on" : ""}">${yy}년</button>`).join("")}</span>
        <span class="muted">집계 수준: ${isAm ? "AM" : "팀"} (사이드바에서 변경) · 비율 옆 괄호는 분자/분모 · 분모 ${mn}건 미만은 ‘표본 부족’</span></div>
    <div class="notice info">점검용 비교이며 AM 평가 점수가 아닙니다. ‘사전/사후 등록’은 수주가능성 변경이력의 첫 기록일로 판단한 <b>추정</b>입니다. 단순 수주율은 사업기회 소멸(Drop)을 분모에 포함하고, Pre-sales 경유 수주율은 제외합니다.</div>
    <div class="grid kpis">
      ${kpiCard("단순 수주율 (A·C)", t.AC.simple.rate == null ? "-" : pct(t.AC.simple.rate), `Win ${nf(t.AC.win)} ÷ (Win+Lose+Drop ${nf(t.AC.win + t.AC.lose + t.AC.drop)})<br>A ${pct(t.A.simple.rate)} · C ${pct(t.C.simple.rate)}`, "", dW({}))}
      ${kpiCard("Pre-sales 경유 수주율", t.AC.pre.rate == null ? "-" : pct(t.AC.pre.rate), `사전 Win ${nf(t.AC.win_pre)} ÷ (사전 Win+Lose ${nf(t.AC.pre.den)})<br>A ${pct(t.A.pre.rate)} · C ${pct(t.C.pre.rate)}`, "a", dW({}, { reg_type: "사전" }))}
      ${kpiCard("사전 등록률", t.AC.reg.rate == null ? "-" : pct(t.AC.reg.rate), `사후·당일 등록 Win ${nf(t.AC.win_post)}건${t.AC.win_nohist ? ` · 이력 없음 ${nf(t.AC.win_nohist)}건` : ""}`, "warn", dW({}, { reg_type: "사후·당일" }))}
      ${kpiCard("리텐션 성공률 (건수)", t.ret_cnt.rate == null ? "-" : pct(t.ret_cnt.rate), `재계약완료 ${nf(t.r_done)} · 해지 ${nf(t.r_churn)}`, "r", dR({}, "해지확정"))}
      ${kpiCard("리텐션 성공률 (금액)", t.ret_amt.rate == null ? "-" : pct(t.ret_amt.rate), `기존 ${amt(t.ret_amt.den)} → 재계약 후 ${amt(t.ret_amt.num)}<br>해지 사유 1위: ${esc(t.churn_top || "-")}`, "r", dR({}, "재계약완료"))}
      ${kpiCard("신규(A) 비중", t.new_share.rate == null ? "-" : pct(t.new_share.rate), `확정 A·C Win 건수 기준 · 월매출 기준 ${pct(t.new_share_amt.rate)}`, "a", Object.assign(dW({}), { acr_type: ["A"] }))}
      ${kpiCard("30일 내 갱신률", t.fresh30.rate == null ? "-" : pct(t.fresh30.rate), `진행 중 ${nf(t.prog)}건 중 ${nf(t.fresh30.num)}건 · 활동 기록 최신성`, "", { scope: "in_progress" })}
      ${kpiCard("장기 미갱신 · 장기 체류", `${nf(t.stale_long)} · ${nf(t.long_stay)}건`, `저장 ${S.f.th.stale_long_days || 90}일 초과 · 최초 기록 ${S.f.th.long_stay_days || 365}일 초과(진행 중)`, "neg", { scope: "checks", code: ["STALE_LONG", "LONG_STAY"] })}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>${isAm ? "AM" : "팀"}별 수주율 비교</h3><p class="desc">단순 vs Pre-sales 경유 수주율 · 분모 ${mn}건 이상만 표시 · ${y}년 수주년월</p><div class="chart-box ${isAm ? "tall" : ""}"><canvas id="pfWinChart"></canvas></div></div>
      <div class="card"><h3>${isAm ? "AM" : "팀"}별 리텐션 성공률</h3><p class="desc">건수 vs 금액 · 분모 ${mn}건 이상만 표시</p><div class="chart-box ${isAm ? "tall" : ""}"><canvas id="pfRetChart"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>성과: 수주율·리텐션 (${y}년 수주년월)</h3><p class="desc">숫자 클릭 → 해당 Funnel 목록</p>
      <div class="table-wrap" style="max-height:620px"><table class="t"><thead><tr><th>${isAm ? "AM(팀)" : "팀"}</th><th class="num">Win (사전/사후)</th><th class="num">Lose</th><th class="num">Drop</th>
        <th class="num">단순 수주율</th><th class="num">경유 수주율</th><th class="num">A 경유</th><th class="num">C 경유</th><th class="num">재계약완료</th><th class="num">해지</th>
        <th class="num">리텐션(건수)</th><th class="num">리텐션(금액)</th><th class="num">재계약 매출 증감률</th><th>해지 사유 1위</th><th class="num">신규(A) 비중</th></tr></thead>
      <tbody>${d.rows.map((r) => perfRow(r, orgLabel(r), orgD(r))).join("")}</tbody>
      <tfoot>${perfRow(t, "담당 합계", {})}</tfoot></table></div></div>
    <div class="card" style="margin-top:14px"><h3>활동성</h3><p class="desc">진행 중·갱신·체류는 현재(기준일 ${esc(S.f.base_date || "")}) 기준, 사전 등록률·리드타임·정확도는 ${y}년 수주년월 기준</p>
      <div class="table-wrap" style="max-height:620px"><table class="t"><thead><tr><th>${isAm ? "AM(팀)" : "팀"}</th><th class="num">진행 중</th><th class="num">30일 내 갱신률</th><th class="num">장기 미갱신(${S.f.th.stale_long_days || 90}일)</th><th class="num">장기 체류</th>
        <th class="num">사전 등록률</th><th class="num">리드타임(중앙값)</th><th class="num">Lose 중 가능성 70%↑</th></tr></thead>
      <tbody>${d.rows.map((r) => actRow(r, orgLabel(r), orgD(r))).join("")}</tbody>
      <tfoot>${actRow(t, "담당 합계", {})}</tfoot></table></div></div>
    ${basisBlock(d.basis)}`;
    $("view").innerHTML = h;
    const okRows = (f) => d.rows.filter(f);
    const pctD = (r) => (r.ok && r.rate != null ? +(r.rate * 100).toFixed(1) : null);
    const barChart = (id, rows, sets) => chart(id, { type: "bar",
      data: { labels: rows.map((r) => (r.am ? `${r.am} (${r.team})` : r.team)), datasets: sets.map(([lb, fn, col]) => ({ label: lb, data: rows.map((r) => pctD(fn(r))), backgroundColor: col, borderRadius: 3, maxBarThickness: 22 })) },
      options: { indexAxis: isAm ? "y" : "x", maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${(isAm ? c.parsed.x : c.parsed.y)}%` } } },
        scales: isAm ? { x: { min: 0, max: 100, title: { display: true, text: "%" } }, y: { ticks: { autoSkip: false } } } : { y: { min: 0, max: 100, title: { display: true, text: "%" } }, x: { grid: { display: false } } } } });
    barChart("pfWinChart", okRows((r) => r.AC.simple.ok || r.AC.pre.ok), [["단순 수주율", (r) => r.AC.simple, css("--pb-2", "#6aa3e0")], ["Pre-sales 경유 수주율", (r) => r.AC.pre, css("--pb-5", "#0d3a75")]]);
    barChart("pfRetChart", okRows((r) => r.ret_cnt.ok), [["리텐션(건수)", (r) => r.ret_cnt, COLORS.R], ["리텐션(금액)", (r) => r.ret_amt, css("--muted", "#6b7280")]]);
    document.querySelectorAll("#pyearSel button").forEach((b) => b.addEventListener("click", () => { S.f.total_year = Number(b.dataset.v); store.set("filters", S.f); render(); }));
  }

  // ------------------------------------------------------------ 페이지: 고객·상품·입찰
  async function pageInsight() {
    const j = await api("/view/insight", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const tab = S.ui.insightTab;
    const tabs = [["customer", "고객사"], ["product", "상품"], ["bid", "공공입찰"], ["reason", "사유 분석"]];
    let body = "";
    if (tab === "customer") {
      body = `${d.customer_warning ? `<div class="notice neg"><b>원본 확인 필요</b> — ${esc(d.customer_warning)}</div>` : ""}<div class="notice warn">고객사 <b>표시명 기준</b> 집계입니다. 마스킹된 이름이 같아도 같은 고객으로 단정하지 않으며, 고객 코드가 없어 고유·신규 고객 수와 유지율은 산출하지 않습니다.</div>
        <div class="toolbar"><input type="text" id="custQ" placeholder="고객사 표시명 검색"><span class="muted">표시명 ${cnt(d.customer_count_display)}개 (상위 200 표시, Funnel 수 순)</span></div>
        <div class="table-wrap" style="max-height:600px"><table class="t" id="custTable"><thead><tr><th>고객사(표시명)</th><th>팀</th><th class="num">Funnel</th><th class="num">진행 중</th><th class="num">확정 ACR(매출개시월, 월매출합계)</th><th class="num">해지확정</th></tr></thead>
        <tbody>${d.customers.map((c) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ customer: c.customer }))}' data-name="${esc(c.customer)}"><td>${esc(c.customer)}</td><td>${esc(c.teams)}</td><td class="num">${cnt(c.funnels)}</td><td class="num">${cnt(c.in_progress)}</td><td class="num">${amt(c.acr)}</td><td class="num">${cnt(c.churn)}</td></tr>`).join("")}</tbody></table></div>`;
    } else if (tab === "product") {
      body = `<div class="notice info">상품1~5와 월매출1~5를 짝으로 처리합니다. ACR은 해당 상품 슬롯의 월매출만 합산(Funnel 전체금액 반복 합산 없음). 계약기간매출은 ‘해당 상품을 보유한 Funnel 전체금액’이며 고유 Funnel당 1회 반영. 상품별 월매출 합계 ≠ 월매출합계 건: <span class="link" data-drill='${esc(JSON.stringify({ scope: "checks", code: "AMOUNT_MISMATCH" }))}'>${cnt(d.product_diff_count)}건</span></div>
        <div class="table-wrap" style="max-height:600px"><table class="t"><thead><tr><th>상품</th><th class="num">보유 Funnel</th><th class="num" title="확정 건 중 해당 상품 슬롯의 월매출만 합산(매출개시월 기준)">A 누적매출(상품별)</th><th class="num" title="확정 건 중 해당 상품 슬롯의 월매출만 합산(매출개시월 기준)">C 누적매출(상품별)</th><th class="num" title="확정 건 중 해당 상품 슬롯의 월매출만 합산(매출개시월 기준)">R 누적매출(상품별)</th><th class="num" title="확정 건 중 해당 상품 슬롯의 월매출만 합산(매출개시월 기준)">A+C+R 누적매출(상품별)</th><th class="num">ACR Funnel</th><th class="num">진행 중 A/C</th><th class="num">진행 중 계약기간매출(Funnel 전체)</th></tr></thead>
        <tbody>${d.products.map((p) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ product: p.product }))}'><td>${esc(p.product)}</td><td class="num">${cnt(p.funnels)}</td><td class="num">${amt(p.acr_A)}</td><td class="num">${amt(p.acr_C)}</td><td class="num">${amt(p.acr_R)}</td><td class="num"><b>${amt(p.acr_ACR)}</b></td><td class="num">${cnt(p.acr_funnels)}</td><td class="num">${cnt(p.prog_ac_count)}</td><td class="num">${amt(p.prog_ac_contract_amt)}</td></tr>`).join("")}</tbody></table></div>`;
    } else if (tab === "bid") {
      body = `<div class="notice info">같은 입찰공고번호의 Funnel을 묶어 보여줄 뿐 중복으로 처리·삭제하지 않습니다. 입찰 마감일은 원본에 없어 표시하지 않습니다. 나라장터 API 연동은 향후 개선사항입니다.</div>
        <div class="grid cols-2"><div><h3>입찰방식별 (A/C, 수주년월 기간 내)</h3><div class="table-wrap"><table class="t"><thead><tr><th>입찰방식</th><th class="num">계</th><th class="num">Pre Sales</th><th class="num">제안완료</th><th class="num">Win</th><th class="num">Lose</th><th class="num">Drop</th><th class="num">계약기간매출</th></tr></thead>
        <tbody>${d.bid_methods.map((m) => `<tr><td>${esc(m.method)}</td><td class="num">${cnt(m.total)}</td><td class="num">${cnt(m["Pre Sales"])}</td><td class="num">${cnt(m["제안완료"])}</td><td class="num">${cnt(m.Win)}</td><td class="num">${cnt(m.Lose)}</td><td class="num">${cnt(m.Drop)}</td><td class="num">${amt(m.contract_amt)}</td></tr>`).join("")}</tbody></table></div></div>
        <div>${reasonTable(d.qualification, "참가자격 (A/C, 기간 내)")}</div></div>
        <h3 style="margin-top:14px">입찰공고번호별 Funnel 묶음 (${cnt(d.bid_funnels)}건)</h3>
        ${d.bid_groups.length ? d.bid_groups.map((g) => `<details class="card" style="margin-bottom:8px"><summary><b>${esc(g.bid_no)}</b> ${esc(g.bid_name || "")} <span class="muted">· Funnel ${g.funnels}건</span></summary>
          <div class="table-wrap" style="margin-top:6px"><table class="t"><thead><tr><th>Funnel번호</th><th>고객사</th><th>팀</th><th>AM</th><th>입찰방식</th><th>수주년월</th><th>현재상황</th><th class="num">계약기간매출</th></tr></thead>
          <tbody>${g.rows.map((r) => `<tr class="clickable" data-row="${r.row}"><td>${esc(r.funnel_id)}</td><td>${esc(r.customer)}</td><td>${esc(r.team)}</td><td>${esc(r.am)}</td><td>${esc(r.bid_method || "-")}</td><td>${esc(r.win_ym)}</td><td>${esc(r.status)}</td><td class="num">${amt(r.contract_amt)}</td></tr>`).join("")}</tbody></table></div></details>`).join("") : '<div class="state">입찰공고번호가 입력된 Funnel이 없습니다(자료 없음).</div>'}`;
    } else {
      const r = d.reasons;
      body = `<div class="notice info">수주년월 기간 내 · 상태에 맞는 사유 열만 집계 · 자유 입력 원문을 임의 통합하지 않음</div>
        <div class="grid cols-3"><div class="card">${reasonTable(r.win, "Win 승패사유 (A/C)")}</div><div class="card">${reasonTable(r.lose, "Lose 승패사유 (A/C)")}</div><div class="card">${reasonTable(r.drop, "Drop 세부사유")}</div>
        <div class="card">${reasonTable(r.churn_reason, "해지사유")}</div><div class="card">${reasonTable(r.churn_type, "해지유형")}</div></div>`;
    }
    $("view").innerHTML = `<div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}" type="button">${l}</button>`).join("")}</div><div class="card">${body}</div>${basisBlock(d.basis)}`;
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { S.ui.insightTab = b.dataset.tab; store.set("ui", S.ui); render(); }));
    const cq = $("custQ");
    if (cq) cq.addEventListener("input", () => { const q = cq.value.trim(); document.querySelectorAll("#custTable tbody tr").forEach((tr) => { tr.style.display = !q || tr.dataset.name.includes(q) ? "" : "none"; }); });
  }

  // ------------------------------------------------------------ 페이지: 우선 확인 / 상세 목록
  async function pagePriority() {
    S.detail = Object.assign(S.detail, { drill: { scope: "checks" }, sort: "level", desc: false, page: 1 });
    return pageDetail(true);
  }
  async function pageDetail(isPriority) {
    const dt = S.detail;
    const j = await api("/detail", { filters: S.f, drill: dt.drill, page: dt.page, size: dt.size, sort: dt.sort, desc: dt.desc, q: dt.q });
    setHeader(j);
    const d = j.data;
    const sortH = (k, l, num) => `<th class="sortable ${num ? "num" : ""}" data-sort="${k}">${l}${dt.sort === k ? (dt.desc ? " ▼" : " ▲") : ""}</th>`;
    const rows = d.rows || [];
    let meta = S.meta && S.meta.rules ? S.meta.rules : null;
    let h = `<div class="card"><div class="toolbar">
        <span class="chip">${esc(d.desc || "전체")}</span>
        <input type="text" id="dq" placeholder="목록 내 검색(고객사·Funnel·AM·팀)" value="${esc(dt.q)}">
        <button class="btn small" id="dqBtn" type="button">검색</button>
        ${isPriority ? "" : `<button class="btn small" id="dReset" type="button">조건 해제(전체)</button>`}
        <button class="btn small primary" id="dExport" type="button">Excel 다운로드</button>
        <span class="muted">총 ${cnt(d.total)}건 · 금액 단위 ${esc(unitName())}</span></div>
      ${isPriority ? '<p class="desc">우선순위는 설명 가능한 조건 규칙으로 계산한 업무 확인 순서이며, 수주 확률이나 AM 평가점수가 아닙니다. 한 Funnel의 여러 사유는 한 행에 모아 표시합니다.</p>' : ""}
      <div class="table-wrap" style="max-height:68vh"><table class="t"><thead><tr>
        ${sortH("level", "우선순위")}<th>확인 사유</th><th>권장 확인 행동</th>${sortH("team", "팀")}${sortH("am", "AM")}${sortH("customer", "고객사")}${sortH("funnel_id", "Funnel번호")}
        ${sortH("acr_type", "유형")}${sortH("status", "현재상황")}${sortH("win_ym", "수주년월")}${sortH("rev_ym", "매출발생년월")}<th class="num">계약기간</th>
        ${sortH("monthly", "월매출합계", 1)}${sortH("contract_amt", "계약기간매출", 1)}${sortH("prev_monthly", "기존매출", 1)}${sortH("new_monthly", "변경매출", 1)}<th class="num">사유 금액(기준)</th>
        <th>수주 가능성</th><th>상품</th>${sortH("updated_at", "최근 갱신일")}<th>최초 등록일</th><th>등록 구분</th><th>ACR 포함</th><th>데이터 품질</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="clickable" data-row="${r.row}">
        <td>${lvTag(r.level) || '<span class="muted">-</span>'}</td><td class="wrap">${(r.checks || []).map((x) => `<span class="tag">${esc(x)}</span>`).join("") || '<span class="muted">-</span>'}</td><td class="wrap">${(r.actions || []).map(esc).join("<br>")}</td>
        <td>${esc(r.team)}</td><td>${esc(r.am)}</td><td>${esc(r.customer)}</td><td>${esc(r.funnel_id)}</td><td>${typeTag(r.acr_type)}</td><td>${esc(r.status)}</td>
        <td>${r.win_ym ? esc(r.win_ym) : '<span class="muted">미입력</span>'}</td><td>${r.rev_ym ? esc(r.rev_ym) : '<span class="muted">미입력</span>'}</td><td class="num">${esc(r.term == null ? "-" : r.term)}</td>
        <td class="num">${amt(r.monthly)}</td><td class="num">${amt(r.contract_amt)}</td><td class="num">${amt(r.prev_monthly)}</td><td class="num">${amt(r.new_monthly)}</td>
        <td class="num">${r.check_amount_basis && (r.checks || []).length ? `${amt(r.check_amount)}<br><span class="muted" style="font-size:11px">${esc(r.check_amount_basis)}</span>` : '<span class="muted">-</span>'}</td>
        <td>${esc(r.prob || "미확인")}</td><td class="wrap">${esc(r.products)}</td><td>${r.updated_at ? esc(r.updated_at) : '<span class="muted">갱신일 미입력</span>'}</td>
        <td>${r.first_reg ? esc(r.first_reg) : '<span class="muted">이력 없음</span>'}</td><td>${r.reg_type ? `<span class="chip ${r.reg_type === "사전" ? "ok" : r.reg_type === "사후·당일" ? "warn" : "gray"}">${esc(r.reg_type)}</span>` : '<span class="muted">-</span>'}</td>
        <td>${r.acr_included ? '<span class="chip ok">포함</span>' : `<span class="chip gray">제외</span><br><span class="muted" style="font-size:11px">${esc(r.acr_excl_reason || "")}</span>`}</td>
        <td class="wrap">${(r.issues || []).map((x) => `<span class="tag" style="background:#fff4e0;color:#7c3f00">${esc(x)}</span>`).join("") || '<span class="muted">-</span>'}${r.agg_excluded ? '<br><span class="neg">집계 제외</span>' : ""}</td></tr>`).join("") || '<tr><td colspan="24"><div class="state">해당 건 없음</div></td></tr>'}</tbody></table></div>
      <div class="pager"><button class="btn small" id="pPrev" ${d.page <= 1 ? "disabled" : ""} type="button">이전</button><span>${d.page || 1} / ${d.pages || 1}</span><button class="btn small" id="pNext" ${(d.page || 1) >= (d.pages || 1) ? "disabled" : ""} type="button">다음</button>
        <select id="pSize">${[50, 100, 200].map((n) => `<option ${dt.size === n ? "selected" : ""}>${n}</option>`).join("")}</select></div></div>
      ${isPriority ? rulesBlock(meta) : ""}`;
    $("view").innerHTML = h;
    const rerun = () => (isPriority ? pageDetail(true) : pageDetail(false)).catch((e) => errorState(e.message));
    document.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => { const k = th.dataset.sort; if (dt.sort === k) dt.desc = !dt.desc; else { dt.sort = k; dt.desc = ["monthly", "contract_amt", "prev_monthly", "new_monthly", "updated_at"].includes(k); } dt.page = 1; rerun(); }));
    $("pPrev").addEventListener("click", () => { dt.page--; rerun(); });
    $("pNext").addEventListener("click", () => { dt.page++; rerun(); });
    $("pSize").addEventListener("change", (e) => { dt.size = parseInt(e.target.value, 10); dt.page = 1; rerun(); });
    const doQ = () => { dt.q = $("dq").value.trim(); dt.page = 1; rerun(); };
    $("dqBtn").addEventListener("click", doQ);
    $("dq").addEventListener("keydown", (e) => { if (e.key === "Enter") doQ(); });
    if ($("dReset")) $("dReset").addEventListener("click", () => { dt.drill = {}; dt.q = ""; dt.page = 1; rerun(); });
    $("dExport").addEventListener("click", () => exportExcel(dt.drill, dt.q));
  }
  function exportExcel(drill, q) {
    const form = document.createElement("form");
    form.method = "POST"; form.action = API + "/export"; form.style.display = "none";
    const add = (n, v) => { const i = document.createElement("input"); i.type = "hidden"; i.name = n; i.value = v; form.appendChild(i); };
    add("filters", JSON.stringify(S.f));
    add("q", JSON.stringify({ drill: drill || {}, q: q || "", source_unit: S.ui.srcUnit }));
    document.body.appendChild(form); form.submit(); form.remove();
  }
  function openDetail(drill) {
    Object.keys(drill).forEach((k) => drill[k] === undefined && delete drill[k]);
    S.detail = { drill, page: 1, sort: drill.scope === "checks" ? "level" : "row", desc: false, q: "", size: S.detail.size || 50 };
    setTimeout(() => go("detail"), 0); // 차트 클릭 처리 중 차트가 제거되지 않도록 다음 틱에 이동
  }

  // ------------------------------------------------------------ 페이지: 데이터 관리
  async function pageData() {
    const j = await api("/view/quality", { filters: S.f });
    setHeader(j);
    const d = j.data;
    let h = `<div class="card"><h3>엑셀 업로드</h3>
      <div class="steps"><span class="on">① 파일 선택</span><span id="st2">② 시트·헤더 확인 및 검증</span><span id="st3">③ 미리보기</span><span id="st4">④ 적용</span></div>
      <div class="upload-box">
        <p class="desc">‘유선Funnel조회’ 양식 .xlsx (최대 ${esc(S.meta.settings.MAX_UPLOAD_MB)}MB). 검증 실패 시 기존 정상 데이터를 유지합니다. 원본 파일은 서버 DATA_DIR/raw 에 그대로 보존됩니다.</p>
        ${ADMIN_REQUIRED ? '<div class="side-row" style="max-width:360px"><input type="password" id="adminTok" placeholder="업로드 권한 토큰" style="border:1px solid #d1d5db;border-radius:6px;padding:6px;background:#fff;color:#111"></div>' : '<div class="notice warn">업로드 권한 토큰(ADMIN_TOKEN)이 설정되지 않아 조회 사용자도 업로드할 수 있습니다. 운영 시 .env 에 설정하세요.</div>'}
        <input type="file" id="upFile" accept=".xlsx"> <button class="btn primary" id="upBtn" type="button">검증</button>
        <div id="upResult"></div></div></div>`;
    if (d.empty) {
      h += `<div class="notice warn" style="margin-top:14px">현재 적용된 원본 데이터가 없습니다. ${esc((d.meta && d.meta.reason) || "")}</div>`;
    } else {
      h += qualityHtml(d);
    }
    $("view").innerHTML = h;
    $("upBtn").addEventListener("click", doUpload);
  }
  function qualityHtml(d) {
    const q = d.quality, s = d.summary, m = d.meta;
    return `${(q.warnings || []).map((w) => `<div class="notice neg" style="margin-top:14px"><b>원본 확인 필요</b> — ${esc(w)}</div>`).join("")}<div class="grid kpis" style="margin-top:14px">
      ${kpiCard("원본 건수", cnt(s.source_rows) + "건", `시트 ${esc(m.sheet)} · 헤더 ${m.header_row}행 · ${m.column_count}열`, "", { scope: "all" })}
      ${kpiCard("대상 본부 건수", cnt(s.in_scope_rows) + "건", `본부 = ${esc(m.target_hq)}`, "", { scope: "all" })}
      ${kpiCard("집계 제외(중복·번호 없음)", cnt(s.agg_excluded_rows) + "건", `중복 그룹 ${q.dup_group_count}개`, s.agg_excluded_rows ? "neg" : "", { scope: "quality" })}
      ${kpiCard("품질 확인 행", cnt(q.rows_with_issues) + "건", "누락·오류·불일치 포함 행", "warn", { scope: "quality" })}
      ${kpiCard("갱신일 미입력 / 기준일 이후", `${cnt(s.missing_update_rows)} / ${cnt(s.future_update_rows)}`, "최근영업활동내역 저장일시", "", { scope: "checks", code: "UPDATE_FUTURE" })}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>오류·누락 유형별 건수</h3><div class="table-wrap"><table class="t"><thead><tr><th>유형</th><th class="num">행 수</th></tr></thead>
        <tbody>${q.issue_counts.map((i) => `<tr><td>${esc(i.label)}</td><td class="num">${cnt(i.rows)}</td></tr>`).join("") || '<tr><td colspan="2" class="muted">없음</td></tr>'}</tbody></table></div>
        ${q.unknown_types.length ? `<p class="neg">알 수 없는 ACR유형: ${q.unknown_types.map(esc).join(", ")}</p>` : ""}${q.unknown_statuses.length ? `<p class="neg">알 수 없는 현재상황: ${q.unknown_statuses.map(esc).join(", ")}</p>` : ""}
        <p class="desc" style="margin-top:6px"><span class="link" data-drill='${esc(JSON.stringify({ scope: "quality" }))}'>품질 확인 행 목록 보기</span> (행 클릭 → 원본 셀 값)</p></div>
      <div class="card"><h3>지표별 포함·제외</h3><div class="table-wrap"><table class="t"><thead><tr><th>지표</th><th class="num">확정 조건 행</th><th class="num">포함</th><th>제외 사유</th></tr></thead>
        <tbody>${d.metrics.map((x) => `<tr><td>${esc(x.metric)}</td><td class="num">${cnt(x.confirmed_rows)}</td><td class="num">${cnt(x.included)}</td><td>${Object.entries(x.excluded).map(([k, v]) => `${esc(k)} ${v}건`).join("<br>") || "없음"}</td></tr>`).join("")}</tbody></table></div>
        <h3 style="margin-top:14px">중복 Funnel번호 그룹</h3>
        ${q.dup_groups.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Funnel번호</th><th>원본 행</th></tr></thead><tbody>${q.dup_groups.map((g) => `<tr><td>${esc(g.funnel_id)}</td><td>${g.rows.join(", ")}</td></tr>`).join("")}</tbody></table></div><p class="desc">임의 병합·삭제하지 않으며 해결 전까지 집계에서 제외합니다.</p>` : '<p class="muted">중복 없음</p>'}
        <h3 style="margin-top:14px">원본 정보</h3><dl class="basis"><dt>파일</dt><dd>${esc(m.file_name)}</dd><dt>업로드 시각</dt><dd>${esc(m.uploaded_at)}</dd>
        <dt>누락 선택 열</dt><dd>${m.missing_optional_columns.length ? m.missing_optional_columns.map(esc).join(", ") : "없음"}</dd><dt>미사용 열</dt><dd>${esc(m.unknown_columns.join(", ") || "없음")}</dd></dl></div></div>`;
  }
  async function doUpload() {
    const f = $("upFile").files[0], out = $("upResult");
    if (!f) { out.innerHTML = '<div class="notice warn">파일을 선택하세요.</div>'; return; }
    const fd = new FormData(); fd.append("file", f);
    const headers = {}; const tok = $("adminTok"); if (tok) headers["X-Admin-Token"] = tok.value;
    out.innerHTML = '<div class="state"><div class="spinner"></div>검증 중…</div>';
    try {
      const r = await fetch(API + "/upload", { method: "POST", body: fd, headers });
      const j = await r.json().catch(() => ({ ok: false, error: `요청 실패 (${r.status})` }));
      if (!j.ok) { out.innerHTML = `<div class="notice neg">검증 실패: ${esc(j.error)}<br>기존 데이터는 그대로 유지됩니다.</div>`; return; }
      $("st2").className = "on"; $("st3").className = "on";
      out.innerHTML = `<div class="notice ok">검증 통과 — 아래 미리보기를 확인한 뒤 적용하세요.</div>${qualityHtml({ quality: j.quality, meta: j.meta, summary: { source_rows: j.meta.row_count, in_scope_rows: j.quality.in_scope_rows, agg_excluded_rows: j.quality.agg_excluded_rows, missing_update_rows: "-", future_update_rows: "-" }, metrics: [] })}
        <div style="margin-top:12px"><button class="btn primary" id="applyUp" type="button">④ 적용</button> <span class="muted">적용 전까지 현재 화면 데이터는 변경되지 않습니다.</span></div>`;
      $("applyUp").addEventListener("click", async () => {
        try {
          const r2 = await fetch(API + "/upload/apply", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers), body: JSON.stringify({ token: j.token }) });
          const j2 = await r2.json();
          if (!j2.ok) throw new Error(j2.error);
          $("st4").className = "on";
          await loadMeta(true);
          out.innerHTML = `<div class="notice ok">적용 완료: ${esc(j2.meta.file_name)} · ${cnt(j2.meta.row_count)}건 · ${esc(j2.meta.uploaded_at)}</div>`;
          setTimeout(() => go("data"), 800);
        } catch (e) { out.insertAdjacentHTML("beforeend", `<div class="notice neg">적용 실패: ${esc(e.message)} — 기존 데이터를 유지합니다.</div>`); }
      });
    } catch (e) { out.innerHTML = `<div class="notice neg">업로드 오류: ${esc(e.message)}</div>`; }
  }

  // ------------------------------------------------------------ 확인 패널 & 원본 행
  async function openPanel() {
    $("drawer").classList.add("open"); $("drawerBg").classList.add("open");
    const b = $("drawerBody");
    b.innerHTML = '<div class="state"><div class="spinner"></div></div>';
    try {
      const [q, v] = await Promise.all([api("/view/quality", { filters: S.f }), S.last && S.last.basisView ? api("/view/" + S.last.basisView, { filters: S.f }) : Promise.resolve(null)]);
      const d = q.data, a = q.applied;
      let h = "";
      h += `<h3>원본 · 업로드 시각</h3>${d.empty ? '<p class="neg">원본 데이터 없음</p>' : `<dl class="basis"><dt>파일</dt><dd>${esc(d.meta.file_name)}</dd><dt>업로드</dt><dd>${esc(d.meta.uploaded_at)}</dd><dt>건수</dt><dd>${cnt(d.meta.row_count)}건 (대상 본부 ${cnt(d.summary.in_scope_rows)}건)</dd></dl>`}`;
      h += `<h3>적용 필터</h3><dl class="basis">${Object.entries(a).map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(typeof val === "object" ? Object.entries(val).map(([x, y]) => `${x}=${y}`).join(", ") : val)}</dd>`).join("")}</dl>`;
      h += `<h3>금액 단위</h3><p>${S.ui.srcUnit === "unknown" ? '<span class="chip warn">원본 단위·확인 필요</span> 원본 숫자를 변환 없이 표시합니다.' : `원본 ${esc(S.ui.srcUnit)}${unitLocked() ? "(서버 설정 확정)" : ""} → 표시 ${esc(S.ui.dispUnit)}`} 계산 중 반올림 없음, 표시할 때만 소수 ${S.ui.dec}자리.</p>`;
      if (!d.empty) {
        h += `<h3>데이터 품질 · 제외</h3><dl class="basis"><dt>집계 제외</dt><dd>${cnt(d.summary.agg_excluded_rows)}건 (중복 그룹 ${d.quality.dup_group_count}개)</dd><dt>품질 확인 행</dt><dd>${cnt(d.quality.rows_with_issues)}건</dd>${(d.quality.warnings || []).map((w) => `<dt class="neg">원본 확인 필요</dt><dd class="neg">${esc(w)}</dd>`).join("")}
          ${d.metrics.map((m) => `<dt>${esc(m.metric)}</dt><dd>확정 조건 ${m.confirmed_rows}건 중 포함 ${m.included}건${Object.keys(m.excluded).length ? " · 제외 " + Object.entries(m.excluded).map(([k, x]) => `${esc(k)} ${x}건`).join(", ") : ""}</dd>`).join("")}</dl>`;
      }
      if (v && v.data && v.data.basis) h += `<h3>계산 기준 (${esc(PAGE_TITLES[S.page])})</h3><dl class="basis">${Object.entries(v.data.basis).map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join("")}</dl>`;
      h += `<h3>운영 설정</h3><dl class="basis"><dt>URL_PREFIX</dt><dd>${esc(S.meta.settings.URL_PREFIX)}</dd><dt>대상 본부</dt><dd>${esc(S.meta.settings.TARGET_HQ)}</dd><dt>업로드 권한</dt><dd>${ADMIN_REQUIRED ? "토큰 필요" : "미설정(누구나 업로드 가능)"}</dd><dt>인증</dt><dd>사내 인증 연동 미적용(확인 필요)</dd></dl>`;
      b.innerHTML = h;
    } catch (e) { b.innerHTML = `<div class="notice neg">${esc(e.message)}</div>`; }
  }
  function closePanel() { $("drawer").classList.remove("open"); $("drawerBg").classList.remove("open"); }
  async function openRaw(row) {
    $("modal").classList.add("open"); $("modalBg").classList.add("open");
    $("modalBody").innerHTML = '<div class="state"><div class="spinner"></div></div>';
    try {
      const j = await api("/raw/" + encodeURIComponent(row));
      const r = j.row;
      $("modalBody").innerHTML = `<h3 style="margin-top:0">원본 행 ${esc(r._row)} <span class="muted" style="font-weight:400">— 원본 셀 값 그대로(정규화 전)</span></h3>
        <div class="table-wrap" style="max-height:70vh"><table class="t"><tbody>${Object.entries(r).filter(([k]) => k !== "_row").map(([k, v]) => `<tr><th style="width:200px;position:static">${esc(k)}</th><td style="white-space:pre-wrap">${v == null ? '<span class="muted">(빈 값)</span>' : esc(v)}</td></tr>`).join("")}</tbody></table></div>`;
    } catch (e) { $("modalBody").innerHTML = `<div class="notice neg">${esc(e.message)}</div>`; }
  }
  function closeModal() { $("modal").classList.remove("open"); $("modalBg").classList.remove("open"); }

  // ------------------------------------------------------------ 라우팅
  const PAGES = { overview: pageOverview, funnel: pageFunnel, renewal: pageRenewal, acr: pageAcr, presales: pagePresales, total: pageTotal, team: pageTeam, perf: pagePerf, insight: pageInsight, priority: pagePriority, detail: () => pageDetail(false), data: pageData };
  const BASIS_VIEW = { overview: "overview", funnel: "funnel", renewal: "renewal", acr: "acr", presales: "presales", total: "total", team: "team", perf: "perf", insight: "insight" };
  function go(page) {
    S.page = page;
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
    try { history.replaceState(null, "", "#" + page); } catch (e) { /* noop */ }
    S.hash = page;
    render();
    window.scrollTo(0, 0);
  }
  async function render() {
    destroyCharts();
    loading();
    $("pageTitle").textContent = PAGE_TITLES[S.page];
    S.last = { basisView: BASIS_VIEW[S.page] };
    try { await PAGES[S.page](); } catch (e) { errorState(e.message); }
  }
  async function loadMeta(keepFilters) {
    S.meta = await api("/meta");
    const saved = store.get("filters", null);
    const def = defaultFilters();
    // 기본 기간이 바뀌면(버전 불일치) 저장된 화면의 조회기간을 새 기본값으로 교체
    if (saved && saved._dv !== S.meta.defaults.version) { delete saved.ym_from; delete saved.ym_to; }
    if (!keepFilters) S.f = saved ? Object.assign(def, saved, { th: Object.assign({}, def.th, saved.th || {}) }) : def;
    S.f._dv = S.meta.defaults.version;
    // 사라진 팀·AM·상품 선택 정리
    S.f.teams = S.f.teams.filter((t) => S.meta.options.teams.includes(t));
    const amKeys = new Set(S.meta.options.ams.map((a) => a.key));
    S.f.ams = S.f.ams.filter((a) => amKeys.has(a));
    S.f.products = S.f.products.filter((p) => S.meta.options.products.includes(p));
    if (!S.meta.options.product_groups || !S.meta.options.product_groups[S.f.product_group]) S.f.product_group = "all";
    const ui = store.get("ui", null);
    if (ui) Object.assign(S.ui, ui);
    if (unitLocked()) S.ui.srcUnit = S.meta.unit.source_unit; // 확정 단위는 저장된 화면 설정보다 우선
    if (!UNIT_WON[S.ui.dispUnit]) S.ui.dispUnit = "백만원";
    renderFilterInputs();
  }

  // ------------------------------------------------------------ 이벤트
  function bind() {
    document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));
    $("applyBtn").addEventListener("click", () => { readFilters(); render(); });
    // 기준일·기간·ACR 기준은 바꾸는 즉시 다시 계산('조회' 버튼 없이도 반영)
    ["f_base", "f_from", "f_to", "f_mode"].forEach((id) => $(id).addEventListener("change", () => { readFilters(); render(); }));
    $("resetBtn").addEventListener("click", () => { S.f = defaultFilters(); $("amSearch").value = ""; $("prodSearch").value = ""; renderFilterInputs(); store.set("filters", S.f); render(); });
    document.querySelectorAll("#f_level button").forEach((b) => b.addEventListener("click", () => { S.f.level = b.dataset.v; document.querySelectorAll("#f_level button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("f_teams").addEventListener("change", () => { S.f.teams = selectedValues("f_teams"); S.f.ams = S.f.ams.filter((k) => !S.f.teams.length || S.f.teams.includes(k.split("|")[0])); renderAmList(); updateCounts(); });
    $("f_ams").addEventListener("change", (e) => { const v = e.target.value; if (e.target.checked) { if (!S.f.ams.includes(v)) S.f.ams.push(v); } else S.f.ams = S.f.ams.filter((x) => x !== v); updateCounts(); });
    $("f_products").addEventListener("change", (e) => { const v = e.target.value; if (e.target.checked) { if (!S.f.products.includes(v)) S.f.products.push(v); } else S.f.products = S.f.products.filter((x) => x !== v); updateCounts(); });
    $("amSearch").addEventListener("input", renderAmList);
    $("prodSearch").addEventListener("input", renderProductList);
    $("f_pgroup").addEventListener("change", (e) => { S.f.product_group = e.target.value; S.f.products = S.f.products.filter((x) => inGroup(x)); renderProductList(); updateCounts(); });
    $("teamClear").addEventListener("click", () => { S.f.teams = []; renderFilterInputs(); });
    $("amClear").addEventListener("click", () => { S.f.ams = []; renderAmList(); updateCounts(); });
    $("prodClear").addEventListener("click", () => { S.f.products = []; renderProductList(); updateCounts(); });
    $("u_src").addEventListener("change", () => { $("u_disp").disabled = $("u_src").value === "unknown"; });
    $("f_search").addEventListener("keydown", (e) => { if (e.key === "Enter") { readFilters(); render(); } });
    $("panelBtn").addEventListener("click", openPanel);
    $("warnChip").addEventListener("click", () => go("data"));
    $("drawerClose").addEventListener("click", closePanel); $("drawerBg").addEventListener("click", closePanel);
    $("modalClose").addEventListener("click", closeModal); $("modalBg").addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePanel(); closeModal(); } });
    $("toggleFilters").addEventListener("click", () => $("sidebar").classList.toggle("show-filters"));
    // 위임: 드릴다운·원본 행·이동
    $("view").addEventListener("click", (e) => {
      const dEl = e.target.closest("[data-drill]");
      if (dEl) { e.stopPropagation(); try { openDetail(JSON.parse(dEl.dataset.drill)); } catch (err) { /* noop */ } return; }
      const gEl = e.target.closest("[data-goto]");
      if (gEl) { go(gEl.dataset.goto); return; }
      const rEl = e.target.closest("tr[data-row]");
      if (rEl) openRaw(rEl.dataset.row);
    });
    window.addEventListener("hashchange", () => { const h = (location.hash || "").replace("#", ""); if (PAGES[h] && h !== S.hash) go(h); });
    $("view").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches(".kpi[data-drill]")) e.target.click(); });
  }

  async function init() {
    bind();
    try {
      await loadMeta(false);
    } catch (e) { errorState("초기 정보를 불러오지 못했습니다: " + e.message); return; }
    const h = (location.hash || "").replace("#", "");
    go(PAGES[h] ? h : "overview");
  }
  init();
})();
