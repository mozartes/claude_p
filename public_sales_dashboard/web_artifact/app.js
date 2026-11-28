/* 공공영업 통합 대시보드 — 화면 로직 (외부 네트워크 없이 동작) */
(function () {
  "use strict";

  const ROOT = document.getElementById("app");
  // 브라우저 계산판: 서버 API 대신 계산 엔진(engine.js)을 직접 호출한다. 엑셀은 이 브라우저 밖으로 나가지 않는다.
  const PSD = window.PSD;
  // 별도 실행판(예: v2)은 저장 공간(필터·브라우저 보관본)을 분리해 기존 버전과 섞이지 않게 한다
  const VARIANT = typeof window.PSD_VARIANT === "string" ? window.PSD_VARIANT : "";
  const css = (name, fb) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; } catch (e) { return fb; } };
  const COLORS = {};
  function refreshColors() {
    COLORS.A = css("--series-a", "#2a78d6"); COLORS.C = css("--series-c", "#eda100"); COLORS.R = css("--series-r", "#eb6834");
    COLORS.AC = css("--series-ac", "#0f766e"); COLORS.ACR = css("--series-total", "#1f2937");
  }
  refreshColors();
  const SERIES_LABEL = { A: "A", C: "C", R: "R 증감", AC: "A+C", ACR: "A+C+R" };
  const UNIT_WON = { "원": 1, "천원": 1e3, "백만원": 1e6, "억원": 1e8 };
  const PAGE_TITLES = {
    overview: "종합 현황", funnel: "수주·Funnel 관리", renewal: "재계약·해지 관리", acr: "ACR 수주(기여매출)", presales: "ACR 수주(Pre-sales)", total: "ACR 수주",
    myteam: "우리 팀 실적", team: "팀·AM 관리", perf: "AM 성과·활동 점검", insight: "고객·상품·입찰 분석", priority: "우선 확인할 Funnel", detail: "상세 목록", data: "데이터 관리",
  };

  const S = {
    meta: null, page: "overview", charts: [], last: null,
    f: null, // filters
    ui: { srcUnit: "unknown", dispUnit: "백만원", dec: 0, acrSeries: ["A", "C", "R", "ACR"], insightTab: "customer" },
    detail: { drill: { period: "rev_ym" }, page: 1, sort: "row", desc: false, q: "", size: 50 },
  };

  // ------------------------------------------------------------ 유틸
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("psdw" + VARIANT + ":" + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("psdw" + VARIANT + ":" + k, JSON.stringify(v)); } catch (e) { /* 무시 */ } },
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
    const tip = ' title="원값 ' + (v < 0 ? "−" : "") + Math.abs(v).toLocaleString("ko-KR", { maximumFractionDigits: 6 }) + '"';
    if (v < 0 && Number(s.replace(/,/g, "")) !== 0) return '<span class="neg"' + tip + '>−' + s + "</span>";
    return '<span' + tip + '>' + s + "</span>";
  }
  const amt = (v) => fmtNum(conv(v));
  const cnt = (v) => (v == null ? '<span class="nodata">자료 없음</span>' : Number(v).toLocaleString("ko-KR"));
  const pct = (v) => (v == null ? '<span class="nodata">산출 불가</span>' : (v < 0 ? '<span class="neg">−' + Math.abs(v * 100).toFixed(1) + "%</span>" : (v * 100).toFixed(1) + "%"));
  const typeTag = (t) => (t ? `<span class="tag t-${esc(t)}">${esc(t)}</span>` : "");
  const lvTag = (lv) => (lv ? `<span class="lv lv${lv}">${["", "높음", "중간", "낮음"][lv]}</span>` : "");

  async function api(path, body) {
    await new Promise((res) => setTimeout(res, 0)); // 로딩 표시가 먼저 그려지도록
    return JSON.parse(JSON.stringify(PSD.call(path, body)));
  }
  function toast(msg, kind) {
    const t = $("toast");
    t.className = "notice " + (kind || "info"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 6000);
  }
  // ---------------- 이 브라우저 보관(IndexedDB): 열람자 본인 브라우저에만 저장, 실패해도 동작
  const IDB = {
    open() { return new Promise((res, rej) => { try { const r = indexedDB.open("psd-dashboard" + VARIANT, 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
    async get() { try { const db = await this.open(); return await new Promise((res) => { const q = db.transaction("files").objectStore("files").get("current"); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (e) { return null; } },
    async put(v) { try { const db = await this.open(); await new Promise((res, rej) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(v, "current"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } },
    async del() { try { const db = await this.open(); await new Promise((res) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").delete("current"); tx.oncomplete = res; tx.onerror = res; }); return true; } catch (e) { return false; } },
  };
  // 기준 파일 내장 데이터(base_data.js): 대시보드 계산에 쓰는 열만 포함
  function loadBase() {
    const b = window.PSD_BASE;
    PSD.loadParsed({ sheet: b.sheet, headerRow: b.headerRow, headers: b.headers, rows: b.rows }, b.meta.file_name, "페이지에 내장", { base: true, excluded_columns: b.meta.excluded_columns });
  }
  let downloadsP = null;
  function getDownloads() {
    if (!downloadsP) downloadsP = (window.claude && typeof window.claude.use === "function") ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);
    return downloadsP;
  }

  // ------------------------------------------------------------ 필터
  function defaultFilters() {
    const d = S.meta.defaults;
    return {
      base_date: d.base_date, ym_from: d.ym_from, ym_to: d.ym_to, level: "all", teams: [], ams: [],
      types: ["A", "C", "R"], products: [], product_group: "all", search: "", mode: "term",
      excl_midlarge: false, excl_rmr: false, confirmed_only: false, th: Object.assign({}, d.th), _dv: d.version, _mv: 2,
    };
  }
  function renderFilterInputs() {
    const f = S.f, o = S.meta.options;
    $("f_base").value = f.base_date; $("f_from").value = f.ym_from; $("f_to").value = f.ym_to;
    $("f_wfrom").value = f.win_from || ""; $("f_wto").value = f.win_to || "";
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
    updateMeBtn();
    $("prodCount").textContent = S.f.products.length ? `${S.f.products.length}개 선택(상품 월매출)` : gl;
  }
  function readFilters() {
    const f = S.f;
    f.base_date = $("f_base").value || S.meta.defaults.base_date;
    f.ym_from = $("f_from").value || S.meta.defaults.ym_from;
    f.ym_to = $("f_to").value || S.meta.defaults.ym_to;
    f.win_from = $("f_wfrom").value || ""; f.win_to = $("f_wto").value || "";
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
    else if (ds.base) { chip.className = "status-line"; chip.title = chip.textContent = `기준 파일 내장 데이터 · ${Number(ds.rows || 0).toLocaleString()}건` + (ds.agg_excluded_rows ? ` · 집계 제외 ${ds.agg_excluded_rows}건` : ""); }
    else {
      chip.className = "status-line";
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
      $("pageSub").textContent = `기준일 ${a["기준일"]} · 수주 기준 ${a["수주 기준 기간"] || "전체"} · 기여매출 기준 ${a["조회기간"]} · ${a["ACR 기준"]}`;
      const chips = [["집계", a["집계 수준"]], ["팀", a["팀"]], ["AM", a["AM"]], ["유형", a["ACR유형"]], ["상품 카테고리", a["상품 카테고리"] === "상품전체(모든 상품)" ? "전체" : a["상품 카테고리"]], ["상품", a["상품"]], ["검색", a["검색"]], ["보조필터", a["보조필터"]]];
      // 기본값과 다른 필터만 칩으로 표시, 전체 칩은 "필터 n개 적용" 버튼으로 펼침
      const isDef = (v) => ["전체", "없음", "미적용", "담당 전체", "A, C, R"].includes(String(v)) || /^전체/.test(String(v));
      const nOn = chips.filter(([, v]) => !isDef(v)).length;
      const ap = $("applied");
      ap.innerHTML = `<button type="button" class="fsum" id="fsumBtn" aria-expanded="${ap.classList.contains("open")}">필터 <b>${nOn}개</b> 적용${nOn ? "" : " · 기본값"} ▾</button>`
        + chips.map(([k, v]) => `<span class="chip ${isDef(v) ? "gray" : ""}">${esc(k)}: ${esc(String(v).length > 60 ? String(v).slice(0, 60) + "…" : v)}</span>`).join("");
      $("fsumBtn").onclick = () => { ap.classList.toggle("open"); $("fsumBtn").setAttribute("aria-expanded", String(ap.classList.contains("open"))); };
    }
  }
  function basisBlock(b, title) {
    if (!b) return "";
    return `<details class="card" style="margin-top:14px"><summary><b>${esc(title || "계산 기준")}</b> <span class="muted">(펼치기)</span></summary>
      <dl class="basis" style="margin-top:8px">${Object.entries(b).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>`;
  }
  // 발생매출(R = 재계약 후 매출 전체, A+C+R = A+C 기여매출 + R 발생) — 종합 현황·ACR 수주(기여매출) 공용, 작은 카드 2장
  function genStrip(ac, acN, rt, basisTxt, side) {
    rt = rt || { amount: null };
    const na = rt.amount === null, naTxt = `<span class="row"><span>${esc(rt.na || "상품 선택 시 산출 안 함")}</span></span>`;
    return `<div class="gen-wrap${side ? " gen-side" : ""}"><div class="gen-h">발생매출 <span class="muted">${esc(basisTxt || "")}</span> <span class="info-i" tabindex="0" title="R. 발생매출 = 재계약완료 건의 재계약 후 월매출(변경매출)을 기여매출과 같은 규칙(매출발생년월·계약기간)으로 반영한 금액. 재계약 때 줄어든 금액이 반영된 실제 매출입니다(증감 아님). A+C+R. 발생매출 = A+C 기여매출 + R. 발생매출. 해지확정 건은 재계약 후 매출이 없어 포함되지 않습니다." aria-label="발생매출 기준">i</span></div>
    <div class="strip two">
      ${na ? kpiCard("A+C+R. 발생매출", "자료 없음", naTxt, "hero gen gen-box")
        : kpiCard("A+C+R. 발생매출", amt(ac + rt.amount), `<span class="row"><span>A+C ${amt(ac)} + R ${amt(rt.amount)}</span></span><span class="row"><span>${cnt(acN + (rt.funnels || 0))}건</span></span>`, "hero gen gen-box", { scope: "acr" })}
      ${side ? "" : genRCard(rt)}
    </div></div>`;
  }
  // R. 발생매출 카드(종합 현황은 기여매출 줄 맨 뒤에 둠)
  function genRCard(rt, cls) {
    rt = rt || { amount: null };
    cls = (cls || "r gen") + " gen-box";
    if (rt.amount === null) return kpiCard("R. 발생매출", "자료 없음", `<span class="row"><span>${esc(rt.na || "상품 선택 시 산출 안 함")}</span></span>`, cls);
    return kpiCard("R. 발생매출", amt(rt.amount), `<span class="row"><span>재계약 전 ${amt(rt.prev_amount)}</span></span><span class="row"><span>감소·증가 ${amt(rt.amount - rt.prev_amount)}</span><span>${cnt(rt.funnels || 0)}건</span></span>`, cls, { scope: "acr", acr_type: ["R"], status: ["재계약완료"] });
  }
  function kpiCard(label, value, meta, cls, drill) {
    return `<div class="card kpi ${cls || ""}" ${drill ? `data-drill='${esc(JSON.stringify(drill))}'` : ""} tabindex="0" role="button">
      <div class="bar"></div><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="meta" title="${esc(String(meta || "").replace(/<br\s*\/?>/g, " · ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())}">${meta || ""}</div></div>`;
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
        case "customer": return opts.compact ? `${esc(r.customer)}<br><span class="muted" style="font-size:13px">${esc(r.funnel_id)}</span>` : esc(r.customer);
        case "check_amount": return `${amt(r.check_amount)}<br><span class="muted" style="font-size:13px">${esc(r.check_amount_basis || "")}</span>`;
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
  const zeroGrid = { color: (ctx) => (ctx.tick && ctx.tick.value === 0 ? css("--muted", "#6b7280") : css("--row-line", "#eef1f6")), lineWidth: (ctx) => (ctx.tick && ctx.tick.value === 0 ? 1.5 : 1) };
  function chart(canvasId, cfg) {
    const el = $(canvasId);
    if (!el || typeof Chart === "undefined") return null;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 13;
    Chart.defaults.color = css("--text-2", "#4b5563");
    const c = new Chart(el, cfg);
    S.charts.push(c);
    return c;
  }
  function tooltipAmt(ctx) { return `${ctx.dataset.label}: ${fmtNum(ctx.parsed.y != null && ctx.chart.options.indexAxis !== "y" ? ctx.parsed.y : ctx.parsed.x).replace(/<[^>]+>/g, "")}`; }
  // ------------------------------------------------------------ 기간 단위(월·분기·반기·연간) 표시 + 증감률
  // 계산 결과(월별 값)를 표시 단위로 묶어 합산만 함. 원 계산 로직은 그대로.
  const PERIODS = [["M", "월별"], ["Q", "분기"], ["H", "반기"], ["Y", "연간"]];
  const CMP_NAME = { M: "MoM", Q: "QoQ", H: "HoH", Y: "YoY" };
  function perOf() {
    const v = (S.ui.perBy || {})[S.page];
    if (["M", "Q", "H", "Y"].includes(v)) return v;
    return S.page === "total" ? "Q" : (["M", "Q", "H", "Y"].includes(S.ui.per) ? S.ui.per : "M");
  }
  function cmpOf() { return S.ui.cmp === "yoy" ? "yoy" : "prev"; }
  function cmpLabel(g, c) { return c === "yoy" || g === "Y" ? "YoY" : CMP_NAME[g]; }
  function periodOf(ym, g) {
    const y = Math.floor(ym / 100), m = ym % 100;
    if (g === "Q") { const q = Math.ceil(m / 3); return { key: `${y}Q${q}`, label: `${y} ${q}분기`, y, i: q, n: 3 }; }
    if (g === "H") { const hh = m <= 6 ? 1 : 2; return { key: `${y}H${hh}`, label: `${y} ${hh === 1 ? "상반기" : "하반기"}`, y, i: hh, n: 6 }; }
    if (g === "Y") return { key: `${y}`, label: `${y}년`, y, i: 1, n: 12 };
    return { key: String(ym), label: `${y}-${String(m).padStart(2, "0")}`, y, i: m, n: 1, ym };
  }
  function prevKey(b, g, c) {
    if (c === "yoy" || g === "Y") return g === "M" ? String((b.y - 1) * 100 + b.i) : g === "Y" ? `${b.y - 1}` : `${b.y - 1}${g}${b.i}`;
    const cnt = { M: 12, Q: 4, H: 2 }[g];
    const y = b.i === 1 ? b.y - 1 : b.y, i = b.i === 1 ? cnt : b.i - 1;
    return g === "M" ? String(y * 100 + i) : `${y}${g}${i}`;
  }
  // monthly: [{ym, A, C, R, AC, ACR, funnels?}] → 기간 묶음(합산). sumFunnels=true일 때만 건수 합산(월별 고유 건수는 합산 불가)
  function aggPeriods(monthly, g, sumFunnels, cutYm) {
    const out = [], idx = {};
    (monthly || []).forEach((m) => {
      if (m.ym == null) return;
      const p = periodOf(m.ym, g);
      if (!idx[p.key]) { idx[p.key] = Object.assign(p, { months: 0, A: 0, C: 0, R: 0, AC: 0, ACR: 0, funnels: sumFunnels || g === "M" ? 0 : null }); out.push(idx[p.key]); }
      const b = idx[p.key];
      if (cutYm && m.ym > cutYm) b.ongoing = true; else b.months += 1;  // 기준월 이후 달은 아직 진행 중(수주 실적 미확정)
      ["A", "C", "R", "AC", "ACR"].forEach((k) => { b[k] += Number(m[k]) || 0; });
      if (b.funnels != null) b.funnels += Number(m.funnels) || 0;
    });
    const cum = { A: 0, C: 0, R: 0, AC: 0, ACR: 0 };
    out.forEach((b) => { b.partial = b.months < b.n; ["A", "C", "R", "AC", "ACR"].forEach((k) => { cum[k] += b[k]; }); b.cum = Object.assign({}, cum); b.cum_ACR = cum.ACR; if (b.ongoing) b.label += " (진행 중)"; else if (b.partial) b.label += " (일부)"; });
    return out;
  }
  // 증감률 = (이번 − 비교) ÷ 비교. 비교 기간이 없거나 0 이하·일부 기간이면 산출하지 않음
  function growthOf(b, pool, g, c, k) {
    const p = pool[prevKey(b, g, c)];
    if (!p) return { r: null, why: "비교 기간 자료 없음" };
    if (b.ongoing || p.ongoing) return { r: null, why: "진행 중인 기간(기준월 이후 포함)" };
    if (b.partial || p.partial) return { r: null, why: "기간 일부만 포함" };
    if (!(p[k] > 0)) return { r: null, why: "비교 값 0 이하" };
    return { r: (b[k] - p[k]) / p[k], prev: p[k] };
  }
  function growthCell(gr) {
    if (gr.r == null) return `<span class="muted" title="${esc(gr.why)}">—</span>`;
    const f1 = (x) => Math.abs(x * 100).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const v = f1(gr.r);
    const tip = `비교 기간 ${fmtNum(conv(gr.prev)).replace(/<[^>]+>/g, "")}`;
    if (gr.r > 0) return `<span class="gr up" title="${esc(tip)}">▲ ${v}%</span>`;
    if (gr.r < 0) return `<span class="gr down" title="${esc(tip)}">▼ ${v}%</span>`;
    return `<span class="gr" title="${esc(tip)}">0.0%</span>`;
  }
  function periodToolbar(id) {
    const g = perOf();
    return `<span class="per-tools" id="${id}"><span class="seg-light" role="group" aria-label="기간 단위">${PERIODS.map(([v, l]) => `<button type="button" data-per="${v}" class="${v === g ? "on" : ""}" aria-pressed="${v === g}">${l}</button>`).join("")}</span></span>`;
  }
  function bindPeriodToolbar(id) {
    const el = $(id); if (!el) return;
    el.querySelectorAll("[data-per]").forEach((b) => b.addEventListener("click", () => { S.ui.perBy = Object.assign({}, S.ui.perBy, { [S.page]: b.dataset.per }); store.set("ui", S.ui); render(); }));
    el.querySelectorAll("[data-cmp]").forEach((b) => b.addEventListener("click", () => { S.ui.cmp = b.dataset.cmp; store.set("ui", S.ui); render(); }));
  }
  // 기간 표: A·C·R·A+C·A+C+R + 증감률(A+C, A+C+R) + 누적 + 건수
  function periodTable(rows, pool, opts) {
    const g = perOf(), drill = opts.drill;
    const cols = g === "Y" ? [["prev", "YoY"]] : [["prev", CMP_NAME[g]], ["yoy", "전년동기 YoY"]];
    const showF = rows.some((b) => b.funnels != null);
    const gh = (k) => cols.map(([, l]) => `<th class="num">${k} ${l}</th>`).join("");
    const gc = (b, k) => cols.map(([c]) => `<td class="num">${growthCell(growthOf(b, pool, g, c, k))}</td>`).join("");
    return `<div class="table-wrap" style="max-height:${opts.maxH || 460}px"><table class="t"><thead><tr><th>${esc(opts.first || "기간")}</th><th class="num">A</th><th class="num">C</th><th class="num">R 증감</th><th class="num">A+C</th>${gh("A+C")}<th class="num">A+C+R</th>${gh("A+C+R")}<th class="num">누적 A+C+R</th>${showF ? `<th class="num">${esc(opts.fLabel || "건수")}</th>` : ""}</tr></thead>
      <tbody>${rows.map((b) => `<tr ${b.ym != null && drill ? `class="clickable" data-drill='${esc(JSON.stringify(drill(b)))}'` : ""}><td>${esc(b.label)}</td><td class="num">${amt(b.A)}</td><td class="num">${amt(b.C)}</td><td class="num">${amt(b.R)}</td><td class="num">${amt(b.AC)}</td>${gc(b, "AC")}<td class="num"><b>${amt(b.ACR)}</b></td>${gc(b, "ACR")}<td class="num">${amt(b.cum_ACR)}</td>${showF ? `<td class="num">${b.funnels == null ? '<span class="muted">—</span>' : cnt(b.funnels)}</td>` : ""}</tr>`).join("") || '<tr><td colspan="12" class="muted">자료 없음</td></tr>'}</tbody></table></div>
      <p class="desc" style="margin-top:6px">${g === "Y" ? "YoY = (올해 − 전년) ÷ 전년" : `${CMP_NAME[g]} = (이번 기간 − 직전 기간) ÷ 직전 기간, 전년동기 YoY = (이번 기간 − 전년 같은 기간) ÷ 전년 같은 기간`}. 비교 기간 자료가 없거나 0 이하, 조회기간이 기간 일부만 포함하거나 기준월 이후가 섞인 진행 중 기간이면 "—"로 표시합니다.${g !== "M" && !opts.sumF ? " 고유 Funnel 건수는 기간 합산이 불가해 월별에서만 표시합니다." : ""}${g !== "M" ? " 행 클릭(목록)은 월별 보기에서 사용할 수 있습니다." : ""}</p>`;
  }
  // 통일 산식 표시용: R → R 증감(RC), A+C+R → A + C + R 증감(ACRN). 계산은 엔진 값(RC·ACRN)을 그대로 씀
  const netRows = (arr) => (arr || []).map((m) => Object.assign({}, m, { Rre: m.R, R: m.RC != null ? m.RC : m.R, ACR: m.ACRN != null ? m.ACRN : m.ACR,
    cum_ACR: m.cum_ACRN != null ? m.cum_ACRN : m.cum_ACR, cum: m.cum ? Object.assign({}, m.cum, { R: m.cum.RC != null ? m.cum.RC : m.cum.R, ACR: m.cum.ACRN != null ? m.cum.ACRN : m.cum.ACR }) : m.cum }));
  const poolOf = (arr) => { const o = {}; arr.forEach((b) => { o[b.key] = b; }); return o; };

  // 탭 묶음(화면별 선택 기억): 아래쪽 표·차트를 탭 1개로 접어 화면 길이를 줄임
  function tabsBlock(id, items) {
    const sel = ((S.ui.tabsBy || {})[id]) || items[0][0];
    const cur = items.some((x) => x[0] === sel) ? sel : items[0][0];
    return `<div class="card tabset" style="margin-top:16px"><div class="tabs" role="tablist">${items.map(([k, l]) => `<button type="button" data-tabgrp="${id}" data-tk="${k}" class="${k === cur ? "on" : ""}" aria-selected="${k === cur}">${l}</button>`).join("")}</div>`
      + items.map(([k, , html]) => `<div class="tab-p" data-tabgrp="${id}" data-tk="${k}" ${k === cur ? "" : "hidden"}>${html}</div>`).join("") + "</div>";
  }
  function acrMonthlyChart(id, monthly, series, onClick, ref) {
    const labels = monthly.map((m) => m.label);
    const ds = [];
    // ref: 같은 기간의 계약기간 반영 A+C+R(그 기간에 실제 발생하는 매출 전체) 굵은 녹색 실선 — 막대는 신규 발생분
    if (ref) ds.push({ type: "line", label: ref.label, key: null, data: ref.rows.map((m) => conv(m.ACR)), borderColor: css("--ok", "#15803d"), backgroundColor: css("--ok", "#15803d"), borderWidth: 4, pointRadius: 3, tension: 0, order: 0, stack: "ref" });
    ["A", "C", "R"].forEach((k) => { if (series.includes(k)) ds.push({ type: "bar", label: SERIES_LABEL[k], key: k, data: monthly.map((m) => conv(m[k])), backgroundColor: COLORS[k], borderRadius: 3, maxBarThickness: 18, order: 2, stack: "bars" }); });
    ["AC", "ACR"].forEach((k) => { if (series.includes(k)) ds.push({ type: "line", label: SERIES_LABEL[k], key: k, data: monthly.map((m) => conv(m[k])), borderColor: COLORS[k], backgroundColor: COLORS[k], borderWidth: 2, pointRadius: 3, tension: 0, order: 1, stack: "line_" + k }); });
    return chart(id, {
      data: { labels, datasets: ds },
      options: {
        maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: tooltipAmt } } },
        scales: { y: { stacked: true, title: { display: true, text: `${(PERIODS.find((x) => x[0] === perOf()) || PERIODS[0])[1]} 금액 (${unitName()})` }, grid: zeroGrid }, x: { stacked: true, grid: { display: false } } },
        onClick: (evt, els, c) => {
          const pts = c.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
          if (!pts.length) return;
          const m = monthly[pts[0].index];
          if (m.ym == null) return;  // 분기·반기·연간 묶음은 목록 이동 없음(월별에서 사용)
          const near = c.getElementsAtEventForMode(evt, "nearest", { intersect: true }, false);
          const key = near.length ? c.data.datasets[near[0].datasetIndex].key : null;
          onClick && onClick(m, key);
        },
      },
    });
  }

  // R 증감 카드 설명: 1줄 = 100만원 이상 / 미만, 2줄 = 재계약 / 해지
  function rCardMeta(sp, rd, chAmt, chN) {
    if (!sp || !sp.big) return `<span class="row"><span>재계약 ${amt(rd)}</span></span><span class="row"><span>해지확정 ${amt(chAmt)}${chN != null ? ` · ${cnt(chN)}건` : ""}</span></span>`;
    // 재계약 / 해지확정 × 기존 월매출 100만원 이상 / 미만
    return `<table class="rgrid" title="기존 월매출(재계약 전) 기준 · 100만원 미만에는 미입력 포함 · 괄호는 건수"><thead><tr><th></th><th>합계</th><th>100만↑</th><th>미만</th></tr></thead><tbody>
      <tr><th>재계약</th><td>${amt(rd)}</td><td>${amt(sp.big.renew)}</td><td>${amt(sp.small.renew)}</td></tr>
      <tr><th>해지확정</th><td>${amt(chAmt)}</td><td>${amt(sp.big.churn)}</td><td>${amt(sp.small.churn)}</td></tr>
      <tr class="rg-tot"><th>R 증감</th><td>${amt(rd + chAmt)}</td><td>${amt(sp.big.R)}</td><td>${amt(sp.small.R)}</td></tr></tbody></table>`;
  }
  // R 증감 구분: 기존 월매출(재계약 전) 100만원 이상 / 미만
  function rSplitLine(v) {
    // 2026-11: ‘R 증감 구분’ 줄은 표시하지 않음(R 증감 카드 안 표에 같은 내용)
    if (v || !v) return "";
    const sp = v && v.r_split; if (!sp) return "";
    const cell = (b, lb, cls) => `<span class="rec-c ${cls}"><b>${lb}</b> ${amt(b.R)} <span class="muted">재계약 ${amt(b.renew)} · ${cnt(b.renew_n)}건 / 해지 ${amt(b.churn)} · ${cnt(b.churn_n)}건</span></span>`;
    return `<div class="ov-ref rec-line" title="R 증감 = 재계약 증감(변경매출 − 기존매출) + 해지 감소. 기존 월매출(재계약 전 월매출)이 100만원 이상인 건과 미만(미입력 포함)인 건으로 나눔. 두 값의 합 = R 증감">
      <span class="rec-k">R 증감 구분</span>${cell(sp.big, "기존 월매출 100만원 이상", "rbig")}${cell(sp.small, "100만원 미만", "rsmall")}</div>`;
  }
  // 기여매출 구성(총 계약기간 구간): 일회성(1개월) · 단기(2~11개월) · Recurring(12개월 이상, 회사 기준). 세 칸 합 = A+C+R 기여매출
  // A+C+R 기여매출 카드 안 ‘계약기간별’ 링크 → 아래 계약기간별(일회성·단기·Recurring) 내역 펼치기/접기
  function recLink(v) {
    if (!(v && v.term_bands)) return "";
    return `<span class="row"><span class="rec-link" data-rec="1" role="button" tabindex="0" aria-expanded="${S.ui.recOpen ? "true" : "false"}">계약기간별 ${S.ui.recOpen ? "▴ 접기" : "▾ 보기"}</span></span>`;
  }
  function recBox(v) {
    const h = recurringLine(v); if (!h) return "";
    return `<div class="rec-box" id="recBox"${S.ui.recOpen ? "" : " hidden"}>${h}</div>`;
  }
  function recurringLine(v) {
    const tb = v && v.term_bands; if (!tb) return "";
    const tot = tb.one.ACR + tb.short.ACR + tb.long.ACR;
    const sh = (x) => (tot ? ` <span class="muted">(${(x / tot * 100).toFixed(1)}%)</span>` : "");
    const cell = (b, cls, strong) => `<span class="rec-c ${cls}"><b>${esc(b.label)}</b> ${strong ? `<b class="rec-v">${amt(b.ACR)}</b>` : amt(b.ACR)}${sh(b.ACR)} <span class="muted">${cnt(b.count)}건 · A ${amt(b.A)} · C ${amt(b.C)} · R 증감 ${amt(b.R)}</span></span>`;
    return `<div class="ov-ref rec-line" title="총 계약기간(원본 ‘계약기간(월)’) 구간별 조회기간 기여매출 · 회사 기준 Recurring = 계약기간 12개월 이상 · R 증감은 재계약 증감 + 해지 감소 · 세 값의 합 = A+C+R 기여매출">
      <span class="rec-k">계약기간별</span>${cell(tb.one, "one")}${cell(tb.short, "new")}${cell(tb.long, "rec", true)}</div>`;
  }

  // ACR 수주 실적: 중대형퍼널제외=Y 건은 기본 제외(ACR 수주 화면의 체크로 끔). 사이드바 보조필터가 켜져 있으면 그대로 적용
  const totExcl = () => S.ui.totExclML !== false;
  const totF = (f) => Object.assign({}, f || S.f, totExcl() ? { excl_midlarge: true } : {});

  // ------------------------------------------------------------ ACR 수주(연도) 목표 달성(종합 현황)
  // 목표 = 연도별 수주(A+C) 목표(억원). 목표 엑셀 불러오기 또는 직접 입력, 이 브라우저에만 저장
  // 회사 목표 수치는 코드에 넣지 않음: 목표 엑셀을 이 브라우저에서 읽어 저장(외부 전송 없음)하거나 칸에 직접 입력
  const TARGET_DEFAULTS = { 2026: { total: 808.2242, leased: 538.2512, non_leased: 269.973,
    teams: { "공공고객팀": 288.6515, "중부기업고객팀": 132.7797, "서부기업고객팀": 132.7797, "동부기업고객1팀": 121.2336, "동부기업고객2팀": 132.7797 } } };
  // 2026년 수주(A+C) 목표(억원) 기본값 — 공개 가능 목표 파일(분기별 시트 연간). 화면 입력·엑셀 불러오기 값이 우선
  // 카드 meta: 실적/목표 달성율 (목표 없으면 건수만)
  // 현재 필터 범위에 맞는 목표(억원): AM 선택·상품 개별 선택 → 없음, 팀 선택 → 선택 팀 목표 합, 팀 미선택 → 담당(상품 카테고리별)
  function scopeTarget(year, teams) {
    const t = targetsOf(year), f = S.f || {};
    teams = teams || f.teams || [];
    if ((f.ams || []).length || (f.products || []).length) return null;
    if (teams.length) {
      if ((f.product_group || "all") !== "all") return null;
      const v = teams.map((k) => (t.teams || {})[k]);
      return v.every((x) => x != null) ? { eok: v.reduce((a, b) => a + b, 0), label: teams.length === 1 ? "팀 목표" : "선택 팀 목표" } : null;
    }
    const pg = f.product_group || "all", e = pg === "leased" ? t.leased : pg === "non_leased" ? t.non_leased : t.total;
    return e == null ? null : { eok: e, label: pg === "all" ? "담당 목표" : pg === "leased" ? "전용회선 목표" : "전용회선외 목표" };
  }
  // 수주(A+C) 카드: 목표가 있으면 큰 숫자 = 실적/목표 + (달성율), 없으면 실적만
  function acCard(label, year, act, cntTxt, drill, teams) {
    const st = scopeTarget(year, teams), g = st ? st.eok * 1e8 / (UNIT_WON[S.ui.srcUnit] || 1e6) : null;
    if (!g) return kpiCard(label, amt(act), `<span class="row"><span>${cntTxt}</span></span>`, "ac-box", drill);
    const r = act / g;
    const v = `<span class="ac-tg"><span class="ac-tg-frac">${fmtNum(conv(act), 0)}/${fmtNum(conv(g), 0)}</span><span class="ac-tg-pct ${r >= 1 ? "tg-ok" : ""}">(${(r * 100).toFixed(1)}%)</span></span>`;
    return kpiCard(label, v, `<span class="row"><span>${cntTxt}</span><span class="muted">${st.label}</span></span>`, "ac-tgc ac-box", drill);
  }

  function targetsOf(year) {
    const all = store.get("targets", {}) || {};
    const d = TARGET_DEFAULTS[year] || {}, u = all[year] || {};
    return Object.assign({}, d, u, { teams: Object.assign({}, d.teams || {}, u.teams || {}) });
  }
  function saveTarget(year, key, val) {
    const all = store.get("targets", {}) || {}, t = Object.assign({ teams: {} }, all[year] || {});
    const v = val === "" || val == null ? null : Number(String(val).replace(/,/g, ""));
    // 빈칸·숫자 아님 → 저장값 삭제(기본 목표로 복귀)
    const tgtObj = key.startsWith("team:") ? (t.teams = Object.assign({}, t.teams)) : t, k = key.startsWith("team:") ? key.slice(5) : key;
    if (Number.isFinite(v)) tgtObj[k] = v; else delete tgtObj[k];
    all[year] = t; store.set("targets", all);
  }
  async function targetSection(year) {
    const base = Object.assign(totF(), { teams: [], ams: [], products: [], total_year: year });
    const [all, le, nl] = await Promise.all(["all", "leased", "non_leased"].map((g) => api("/view/total", { filters: Object.assign({}, base, { product_group: g }) }).then((x) => x.data || {})));
    if (!all || all.empty) return "";
    const t = targetsOf(year);
    const srcWon = UNIT_WON[S.ui.srcUnit] || 1e6;
    const toSrc = (eok) => (eok == null ? null : eok * 1e8 / srcWon);
    const rows = [["담당 전체", "total", all.totals.AC, t.total, true]]
      .concat((all.by_team || []).slice().sort((a, b) => { const ord = Object.keys((TARGET_DEFAULTS[year] || {}).teams || {}), ia = ord.indexOf(a.key), ib = ord.indexOf(b.key); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.key).localeCompare(String(b.key), "ko"); }).map((r) => [r.key, `team:${r.key}`, r.AC, (t.teams || {})[r.key], false]))
      .concat([["전용회선", "leased", le.empty ? 0 : le.totals.AC, t.leased, true], ["전용회선외", "non_leased", nl.empty ? 0 : nl.totals.AC, t.non_leased, true]]);
    S.tgData = { labels: rows.map((r) => r[0]), tgt: rows.map((r) => toSrc(r[3])), act: rows.map((r) => r[2]) };
    const pctTxt = (a, g) => (g ? `${((a / g) * 100).toFixed(1)}%` : "—");
    const tr = rows.map(([lb, key, act, tg, strong]) => {
      const g = toSrc(tg), rate = g ? act / g : null, w = rate == null ? 0 : Math.min(100, rate * 100);
      return `<tr class="${strong ? "tg-strong" : ""}"><td>${esc(lb)}</td>
        <td class="num">${g == null ? '<span class="muted">목표 없음</span>' : amt(g)}</td><td class="num"><b>${amt(act)}</b></td>
        <td class="num">${g == null ? "—" : `<span class="tg-frac">${fmtNum(conv(act), 0)} / ${fmtNum(conv(g), 0)}</span> = <b class="${rate >= 1 ? "tg-ok" : ""}">${pctTxt(act, g)}</b>`}</td>
        <td><span class="tm-bar tg-bar"><span style="width:${w.toFixed(1)}%"></span></span></td>
        <td class="num">${g == null ? "—" : amt(act - g)}</td></tr>`;
    }).join("");
    return `<section class="ov-sec"><div class="ov-h"><h3>ACR 수주(${year}년) 목표 달성 <span class="h-period">${year}년 수주(A+C) 실적 ÷ 목표</span> <span class="info-i" tabindex="0" title="실적 = ACR 수주 화면의 ${year}년 수주(A+C)(계약 전체 기간, 확정 A·C${totExcl() ? ", 중대형퍼널제외=Y 제외" : ""}). 팀·AM 필터와 무관하게 담당 전체·팀별로 계산. 전용회선 = 국내전용+국제전용 상품 금액, 전용회선외 = 나머지 상품(두 값의 합은 상품별 금액 입력 차이로 전체와 조금 다를 수 있음). 목표는 억원으로 입력, 1억원 = 100백만원. 목표는 이 브라우저에만 저장">i</span></h3><span class="unit">단위 ${esc(unitName())} · 목표 억원</span></div>
      <div class="card"><div class="chart-box tg-chart"><canvas id="tgChart" role="img" aria-label="${year}년 수주 목표 대비 실적 막대그래프"></canvas></div>
      <p class="desc ot-legend"><i class="ot-sw t"></i>목표 <i class="ot-sw a"></i>실적 · 막대 위 % = 달성율(100% 이상 초록, 70% 미만 빨강) · 단위 ${esc(unitName())}</p>
      <details class="ot-tbl"><summary>표로 보기(목표 · 실적 · 달성율 · 차이)</summary><div class="table-wrap"><table class="t tg-t"><thead><tr><th>구분</th><th class="num">목표</th><th class="num">실적 ${year}년 수주(A+C)</th><th class="num">달성율 (실적 / 목표)</th><th>진척</th><th class="num">차이</th></tr></thead><tbody>${tr}</tbody></table></div></details>
      <div class="toolbar tg-tools">${window.XLSX ? `<label class="btn small primary tg-import">목표 엑셀 불러오기<input type="file" id="tgFile" accept=".xlsx,.xls" hidden></label>` : ""}<button type="button" class="btn small" id="tgClear">목표 지우기</button>
        <span class="muted">‘전체 목표’ 시트(구분 · 전체상품 · 전용회선 · 전용회선 외)를 읽어 이 브라우저에만 저장합니다. 파일은 외부로 전송되지 않습니다.</span></div></div></section>`;
  }
  // 목표 엑셀(‘전체 목표’ 시트: 구분 | 전체상품 | 전용회선 | 전용회선 외, 행 = 공공담당·팀) → 이 브라우저에 저장
  // 분기별 목표 시트(구분 | 1Q 2Q 3Q 4Q 1H 2H 연간, 각 기간 아래 ‘목표’ 열; 블록 제목 ‘총수주’·‘전용회선수주’) → { all: {조직: [7]}, leased: {...} }
  function parseQuarterTargets(wb) {
    const norm = (v) => String(v == null ? "" : v).replace(/\s/g, "");
    const name = wb.SheetNames.find((n) => /분기/.test(n)); if (!name) return null;
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
    const P = [["1Q"], ["2Q"], ["3Q"], ["4Q"], ["1H", "상반기"], ["2H", "하반기"], ["연간", "년간", "합계"]], out = {};
    rows.forEach((r, hr) => {
      const cols = P.map((alts) => r.findIndex((v) => alts.includes(norm(v))));
      if (cols[0] < 0 || cols[3] < 0) return;
      const title = [rows[hr - 1], rows[hr - 2]].filter(Boolean).flat().map(norm).join(" ");
      const kind = /전용/.test(title) ? "leased" : "all";
      const sub = rows[hr + 1] || [], hasSub = sub.some((v) => norm(v) === "목표");
      const tcol = cols.map((c) => { if (c < 0) return -1; if (!hasSub) return c; for (let k = c; k < c + 3; k++) if (norm(sub[k]) === "목표") return k; return c; });
      const kc = r.findIndex((v) => norm(v) === "구분");
      const map = {};
      for (let i = hr + (hasSub ? 2 : 1); i < rows.length; i++) {
        const row = rows[i] || [], key = norm(row[kc >= 0 ? kc : Math.max(0, cols[0] - 1)]);
        if (!key || row.some((v) => ["1Q", "구분"].includes(norm(v)))) break;
        const nm = /담당/.test(key) ? "담당 전체" : /팀$/.test(key) ? key : null; if (!nm) continue;
        const val = (c) => (c >= 0 && row[c] !== null && row[c] !== "" && Number.isFinite(Number(row[c])) ? Number(row[c]) : null);
        const q = tcol.slice(0, 4).map(val); if (q.some((x) => x === null)) continue;
        const h1 = val(tcol[4]) ?? q[0] + q[1], h2 = val(tcol[5]) ?? q[2] + q[3], yr = val(tcol[6]) ?? h1 + h2;
        map[nm] = [q[0], q[1], q[2], q[3], h1, h2, yr];
      }
      // 담당 전체를 맨 위로
      const ord = Object.keys(map).sort((x, z) => (x === "담당 전체" ? -1 : z === "담당 전체" ? 1 : 0)), m2 = {};
      ord.forEach((k) => { m2[k] = map[k]; });
      if (ord.length && !out[kind]) out[kind] = m2;
    });
    return out.all ? out : null;
  }
  function importTargets(file, year) {
    if (!window.XLSX) { alert("이 화면에서는 엑셀을 읽을 수 없습니다. 목표 칸에 직접 입력하세요."); return; }
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const wb = window.XLSX.read(new Uint8Array(rd.result), { type: "array" });
        const name = wb.SheetNames.find((n) => n.replace(/\s/g, "").includes("전체목표")) || wb.SheetNames[0];
        const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
        const norm = (v) => String(v == null ? "" : v).replace(/\s/g, "");
        const hi = rows.findIndex((r) => r.some((v) => norm(v) === "전체상품"));
        if (hi < 0 && !parseQuarterTargets(wb)) throw new Error("‘전체상품’ 머리글(또는 분기별 목표 시트)을 찾지 못했습니다.");
        const head = hi < 0 ? [] : rows[hi].map(norm), cAll = head.indexOf("전체상품"), cLe = head.indexOf("전용회선"), cNl = head.findIndex((v) => v === "전용회선외");
        const cKey = head.findIndex((v) => v === "구분"), yr = (String(rows.flat().find((v) => /\d{2}년도/.test(String(v || ""))) || "").match(/(\d{2})년도/) || [])[1];
        const y = yr ? 2000 + Number(yr) : year, teams = new Set(S.meta.options.teams || []), t = { teams: {} };
        (hi < 0 ? [] : rows.slice(hi + 1)).forEach((r) => {
          const k = norm(r[cKey < 0 ? 0 : cKey]), num = (c) => (c >= 0 && Number.isFinite(Number(r[c])) && r[c] !== null && r[c] !== "" ? Number(r[c]) : null);
          if (!k) return;
          if (/담당/.test(k)) { t.total = num(cAll); if (num(cLe) !== null) t.leased = num(cLe); if (num(cNl) !== null) t.non_leased = num(cNl); }
          else if (teams.has(k) || /팀$/.test(k)) { if (num(cAll) !== null) t.teams[k] = num(cAll); }
        });
        const qt = parseQuarterTargets(wb);
        if (t.total == null && !Object.keys(t.teams).length && qt) {
          // ‘전체 목표’ 시트가 없으면 분기 시트의 연간 목표로 채움
          const a = qt.all, l = qt.leased || {};
          if (a["담당 전체"]) t.total = a["담당 전체"][6];
          if (l["담당 전체"]) { t.leased = l["담당 전체"][6]; if (t.total != null) t.non_leased = t.total - t.leased; }
          Object.keys(a).forEach((k) => { if (k !== "담당 전체") t.teams[k] = a[k][6]; });
        }
        if (t.total == null && !Object.keys(t.teams).length) throw new Error("담당·팀 목표 행을 찾지 못했습니다.");
        const all = store.get("targets", {}) || {}; all[y] = t; store.set("targets", all);
        const oq = store.get("orderTargets", {}) || {};
        if (qt) oq[y] = qt; else delete oq[y];
        store.set("orderTargets", oq);
        toast(qt ? `${y}년 목표를 불러왔습니다(연간 + 분기·반기 목표).` : `${y}년 연간 목표를 불러왔습니다. 분기별 시트가 없어 ACR 수주의 분기·반기 표는 기본 목표를 씁니다.`);
        render();
      } catch (e) { alert("목표 파일을 읽지 못했습니다: " + e.message); }
    };
    rd.readAsArrayBuffer(file);
  }
  function bindTargets(year) {
    document.querySelectorAll("input[data-tg]").forEach((el) => el.addEventListener("change", () => { saveTarget(year, el.dataset.tg, el.value.trim()); render(); }));
    const fi = $("tgFile"); if (fi) fi.addEventListener("change", () => { if (fi.files && fi.files[0]) importTargets(fi.files[0], year); });
    const clr = $("tgClear"); if (clr) clr.addEventListener("click", () => { const all = store.get("targets", {}) || {}; delete all[year]; store.set("targets", all); const oq = store.get("orderTargets", {}) || {}; delete oq[year]; store.set("orderTargets", oq); render(); });
  }

  // ------------------------------------------------------------ 페이지: 종합 현황
  async function pageOverview() {
    const j = await api("/view/overview", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const k = d.kpi, a = k.acr;
    const sampleNote = j.dataset.sample ? '<div class="notice warn sample-banner"><span><b>예시 데이터</b> — 팀·AM은 실제 조직, 고객·금액·건수·일정은 가상 값입니다. 해당 AM의 실제 실적이 아닙니다.</span><span class="link" data-goto="data">실제 엑셀 선택</span></div>' : "";
    const ml = S.f.mode === "term" ? "계약기간 반영 추정" : "매출개시월 기준";
    const acDrill = { scope: "acr", acr_type: ["A", "C"] };
    // 누적매출 = 조회기간(매출발생년월 기준) 확정 ACR 월매출 증감액의 합계
    const accBasis = `확정 ACR · ${ml} · ${S.f.ym_from}~${S.f.ym_to} 합계`;
    const pb = `${ml} · ${S.f.ym_from}~${S.f.ym_to} 합계`;
    const rt = k.retention || { amount: null, na: "자료 없음" };
    // ---- B안 표시 도우미(계산 없음: 이미 계산된 값의 비중·막대만 그림) ----
    const pctOf = (v, t) => (t > 0 && Number.isFinite(v) ? (v / t * 100).toFixed(1) + "%" : "—");
    const wOf = (v, t) => (t > 0 && v > 0 ? Math.min(100, v / t * 100).toFixed(2) : 0);
    const mini = (o) => `<div class="mini" aria-hidden="true"><span style="width:${wOf(o.A, o.ACR)}%;background:var(--series-a)"></span><span style="width:${wOf(o.C, o.ACR)}%;background:var(--series-c)"></span><span style="width:${wOf(o.R, o.ACR)}%;background:var(--series-r)"></span></div>`;
    const spark = (key, col) => {
      const vals = (d.acr_monthly || []).map((m) => Number(m[key]) || 0);
      if (vals.length < 2) return "";
      const mx = Math.max(...vals.map(Math.abs), 1e-9), W = 120, H = 30;
      const yy = (v) => (H - 3 - Math.max(0, v) / mx * (H - 6)).toFixed(1);
      const pts = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${yy(v)}`).join(" ");
      return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${H} ${pts} ${W},${H}" fill="${col}" opacity=".14"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/><circle cx="${W}" cy="${yy(vals[vals.length - 1])}" r="2.4" fill="${col}"/></svg>`;
    };
    const info = (t) => `<span class="info-i" title="${esc(t)}" tabindex="0" aria-label="${esc(t)}">i</span>`;
    const row = (l, r) => `<span class="row"><span>${l}</span><span>${r}</span></span>`;
    let h = sampleNote;
    // ① 핵심 KPI — 시안(2026-11): 줄마다 Hero(A+C+R) + A · C · R 증감 · A+C 5장, 설명 2줄 이내, R 재계약은 참고 1줄
    const sub = (t) => `<span class="h-period">${t}</span>`;
    const heroMeta = (o, rc, fn) => `${row(`A+C ${amt(o.AC)} + R 증감 ${amt(rc)}`, fn)}<div class="mini" aria-hidden="true"><span style="width:${wOf(o.A, o.AC)}%;background:var(--series-a)"></span><span style="width:${wOf(o.C, o.AC)}%;background:var(--series-c)"></span></div>${row(`A ${pctOf(o.A, o.AC)} · C ${pctOf(o.C, o.AC)}`, "A+C 구성비")}`;
    const rcCard = (rd, chAmt, chN, drill, sp) => kpiCard("R 증감", amt(rd + chAmt), rCardMeta(sp, rd, chAmt, chN), "neg", drill);
    let tk = d.total_kpi;
    // ACR 수주 줄은 ACR 수주 화면과 같은 기준(중대형퍼널제외=Y 기본 제외)
    if (tk && totExcl() && !S.f.excl_midlarge) {
      const tv = (await api("/view/total", { filters: totF() })).data;
      if (tv && !tv.empty) tk = Object.assign({}, tv.totals, { year: tv.year, r_ref: tv.r_ref, churn_ref: tv.churn_ref, excluded: tv.excluded, r_split: tv.r_split });
    }
    if (tk) {
      const tdk = (extra) => Object.assign({ scope: "total" }, extra || {});
      const exn = Object.values(tk.excluded || {}).reduce((x, y) => x + y, 0);
      const pSel = S.f.products.length || S.f.product_group !== "all";
      // R 증감 = 재계약 증감 × 계약기간 + 해지 감소 × 계약기간, A+C+R 수주 = A + C + R 증감
      const cr = tk.churn_ref || { amount: 0, count: 0, excluded: 0 }, rf0 = tk.r_ref || { new_total: 0, prev_total: 0 };
      const rdT = pSel ? tk.R : rf0.new_total - rf0.prev_total, rChgT = rdT + cr.amount, acrT = tk.A + tk.C + rChgT;
      h += `<section class="ov-sec"><div class="ov-h"><h3>ACR 수주 ${sub(`${tk.year}년 수주 · 계약 전체 기간`)} ${info(`확정 건(A·C=Win, R=재계약완료)의 계약 전체 기간 매출을 수주년월(${tk.year}-01~12)에 합산 · A+C+R = A + C + R 증감(재계약 증감 + 해지 감소, 계약기간 기준)${exn ? ` · 계약기간 누락 등 ${exn}건 제외` : ""} · 연도는 ACR 수주 화면에서 변경`)}</h3><span class="unit">단위 ${esc(unitName())}</span></div>
      <div class="strip five ac-first">
        ${acCard(`${tk.year}년 수주(A+C)`, tk.year, tk.AC, `${cnt(tk.funnels_A + tk.funnels_C)}건`, tdk({ acr_type: ["A", "C"] }))}
        ${kpiCard("A+C+R 수주", amt(acrT), heroMeta(tk, rChgT, `A+C ${cnt(tk.funnels_A + tk.funnels_C)}건`), "hero", tdk())}
        ${kpiCard("A 수주", amt(tk.A), row(`${cnt(tk.funnels_A)}건`, `A+C 중 ${pctOf(tk.A, tk.AC)}`), "a", tdk({ acr_type: ["A"] }))}
        ${kpiCard("C 수주", amt(tk.C), row(`${cnt(tk.funnels_C)}건`, `A+C 중 ${pctOf(tk.C, tk.AC)}`), "c", tdk({ acr_type: ["C"] }))}
        ${rcCard(rdT, cr.amount, cr.count, { status: ["해지확정"], period: "win_ym" }, tk.r_split)}
      </div>
      ${rSplitLine(tk)}</section>`;
    }
    // 매출개시월 기준 같은 계산(월별 신규 발생 차트·Recurring 구분용)
    const svOv = S.f.mode === "term" ? (await api("/view/acr", { filters: Object.assign({}, S.f, { mode: "start" }) })).data : null;
    const acrOv = (await api("/view/acr", { filters: S.f })).data;  // 계약기간 구간별 구성(같은 기준)
    // ACR 수주(연도) 목표 달성
    const tgYear = (tk && tk.year) || S.f.total_year || Number(String(S.f.base_date || "2026").slice(0, 4));
    h += await targetSection(tgYear);
    // ① 핵심 KPI — 2줄: ACR 기여매출(조회기간 실제 발생분)
    const chX = k.churn_acr || { amount: 0, funnels: 0 };
    const rdX = rt.amount === null ? a.R : rt.amount - rt.prev_amount;
    const rChg = rdX + chX.amount, acrNet = a.A + a.C + rChg;
    h += `<section class="ov-sec"><div class="ov-h"><h3>ACR 기여매출 ${sub(`${esc(S.f.ym_from)}~${esc(S.f.ym_to)} ${S.f.mode === "term" ? "실제 발생분(계약기간 반영)" : "신규 발생분(매출개시월)"}`)} ${info(`${S.f.mode === "term" ? "확정 ACR 중 조회기간에 매출이 발생하는 부분(계약기간 동안 매월 반영)" : "확정 ACR 중 매출발생년월이 조회기간 안인 건의 월매출(그 달에 새로 시작된 매출만, 다음 달부터는 미반영 · 사이드바 ‘ACR 기준’에서 계약기간 반영으로 전환 가능)"} · ${ml} · A+C+R = A + C + R 증감(재계약 증감 + 해지 감소)${rt.amount === null ? " · 상품 선택 시 R은 재계약 증감 기준" : ""}`)}</h3><span class="unit">단위 ${esc(unitName())}</span></div>
    <div class="gen-row">${genStrip(a.AC, a.funnels_A + a.funnels_C, rt, "A+C 기여매출 + R 발생매출", true)}
    <div class="strip five six">
      ${kpiCard("A+C+R 기여매출", amt(acrNet), heroMeta(a, rChg, `고유 ${cnt(a.funnels)}건`) + recLink(acrOv), "hero", { scope: "acr" })}
      ${kpiCard("A 기여매출", amt(a.A), row(`${cnt(a.funnels_A)}건`, `A+C 중 ${pctOf(a.A, a.AC)}`), "a", { scope: "acr", acr_type: ["A"] })}
      ${kpiCard("C 기여매출", amt(a.C), row(`${cnt(a.funnels_C)}건`, `A+C 중 ${pctOf(a.C, a.AC)}`), "c", { scope: "acr", acr_type: ["C"] })}
      ${rcCard(rdX, chX.amount, chX.funnels, { status: ["해지확정"], period: "rev_ym" }, acrOv && acrOv.r_split)}
      ${kpiCard("A+C 기여매출", amt(a.AC), row(`${cnt(a.funnels_A + a.funnels_C)}건`, ""), "", { scope: "acr", acr_type: ["A", "C"] })}
      ${genRCard(rt, "r")}
    </div>
    </div>
    ${recBox(acrOv)}${rSplitLine(acrOv)}</section>`;
    // ③ 확인 필요 — 음수·위험 신호를 한 곳에 모음(값은 기존 계산 그대로)
    const ch = k.churn_acr || { amount: 0, funnels: 0, excluded: {} };
    const chEx = Object.values(ch.excluded || {}).reduce((x, y) => x + y, 0);
    const rd = rt.amount === null ? a.R : rt.amount - rt.prev_amount;  // R 증감액
    const exAcr = Object.values(d.acr_excluded || {}).reduce((x, y) => x + y, 0);
    // 월별 차트·기간별 표 = 신규 발생분(매출개시월). 계약기간 반영 기준이면 같은 계산을 매출개시월로 한 번 더 조회
    const termOv = S.f.mode === "term";
    const newMonthly = termOv ? ((svOv || {}).monthly || []) : d.acr_monthly;
    const ovRows = aggPeriods(netRows(newMonthly), perOf(), false);
    const ovRef = termOv ? { label: "A+C+R 매출(월증가)", rows: aggPeriods(netRows(d.acr_monthly), perOf(), false) } : null;
    const warns = ((j.dataset || {}).warnings || []).length;
    const risks = [
      ["hi", "R 증감 (재계약 증감 + 해지 감소)", `재계약 증감 ${amt(rd)} + 해지 감소 ${amt(ch.amount)} · 해지확정 ${cnt(ch.funnels)}건${chEx ? ` (계산 제외 ${cnt(chEx)}건)` : ""} · A+C+R에 포함`, amt(rd + ch.amount), rd + ch.amount < 0, `data-drill='${esc(JSON.stringify({ status: ["해지확정"], period: "rev_ym" }))}'`],
      ["hi", "우선 확인 Funnel (높음)", `확인 필요 고유 Funnel ${cnt(k.check_count)}건 중 높음 등급`, `${cnt(k.check_level1)}건`, false, 'data-goto="priority"'],
      ["md", "수주 예정월 경과", "진행 중 A/C·R 중 수주 예정월이 지난 건", `${cnt(d.overdue_count)}건`, false, `data-drill='${esc(JSON.stringify({ scope: "in_progress", bucket: "예정월 경과" }))}'`],
      ["md", "계산에서 제외된 확정 건", d.acr_excluded ? Object.keys(d.acr_excluded).map(esc).join(", ") || "해당 없음" : "해당 없음", `${cnt(exAcr)}건`, false, `data-drill='${esc(JSON.stringify({ scope: "acr_excluded" }))}'`],
      ["md", "원본 확인 필요", "원본 파일 검사 경고(데이터 관리에서 상세 확인)", `${cnt(warns)}건`, false, 'data-goto="data"'],
    ];
    const riskCount = risks.filter((x, i) => (i === 0 ? x[4] : !/^0건$/.test(String(x[3]).replace(/<[^>]+>/g, "")))).length;
    h += `<section class="ov-sec ov-split">
      <div class="card"><div class="card-head"><h3>② 기간별 신규 발생 매출 ${info(`막대 A·C·R 증감·선 A+C+R = 그 기간에 매출이 새로 시작된 건(매출발생년월 기준)${termOv ? " · 굵은 녹색 선 A+C+R 매출(월증가) = 그 기간에 실제 발생하는 매출 전체(이전에 시작해 계약기간이 남은 건 포함, 위 카드 합계와 같은 기준)" : ""} · 0 기준선 아래는 감액 · 월별 보기에서 클릭 → 그 달에 매출이 시작된 Funnel`)}</h3>${periodToolbar("ovPer")}</div>
        <div class="chart-box"><canvas id="ovChart"></canvas></div>
        <details class="per-table" ${perOf() !== "M" ? "open" : ""}><summary>기간별 표 · ${perOf() === "Y" ? "YoY" : `${CMP_NAME[perOf()]} · 전년동기 YoY`} 증감률</summary>${termOv ? '<p class="desc">신규 발생분(그 기간에 매출이 시작된 건) · 기간 합은 위 카드(계약기간 반영 합계)와 다름</p>' : ""}${periodTable(ovRows, poolOf(ovRows), { drill: (x) => ({ scope: "acr", rev_month: x.ym }), maxH: 300, fLabel: "고유 Funnel" })}</details></div>
      <div class="card"><div class="card-head"><h3>③ 확인 필요</h3><span class="muted">${riskCount}건</span></div>
        <div class="alert-list">${risks.map(([lv, t, ds, v, neg, act]) => `<div class="alert" role="button" tabindex="0" ${act}><span class="sbar ${lv}"></span><div><div class="t">${t}</div><div class="d">${ds}</div></div><div class="v ${neg ? "negv" : ""}">${v}</div></div>`).join("")}</div></div>
    </section>`;
    // ④ 팀·AM별 확인 과제
    const maxL = Math.max(1, ...d.team_checks.map((t) => t.level1 || 0));
    h += `<section class="ov-sec"><div class="card"><div class="card-head"><h3>④ ${S.f.level === "am" ? "AM" : "팀"}별 확인 과제</h3><span class="muted">우선 확인 규칙에 해당하는 고유 Funnel 수 · 행 클릭 → 목록</span></div>
        <div class="table-wrap" style="max-height:340px"><table class="t"><thead><tr><th>${S.f.level === "am" ? "AM(팀)" : "팀"}</th><th class="num">확인 Funnel</th><th class="num">높음</th><th class="num">예정월 경과</th><th class="num">감액 예상</th><th class="num">장기 미갱신(${S.f.th.stale_long_days}일)</th></tr></thead>
        <tbody>${d.team_checks.map((t) => `<tr class="clickable" data-drill='${esc(JSON.stringify(S.f.level === "am" ? { scope: "checks", am_key: t.key } : { scope: "checks", team: t.key }))}'>
          <td>${esc(t.am ? `${t.am} (${t.team})` : t.team)}</td><td class="num">${cnt(t.funnels)}</td><td class="num"><span class="heat" style="background:color-mix(in srgb, var(--neg) ${Math.round((t.level1 || 0) / maxL * 26)}%, transparent)">${cnt(t.level1)}</span></td>
          <td class="num">${cnt(t.by_code.OVERDUE || 0)}</td><td class="num">${cnt(t.by_code.RENEWAL_DECREASE || 0)}</td><td class="num">${cnt(t.by_code.STALE_LONG || 0)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">해당 없음</td></tr>'}</tbody></table></div></div></section>`;
    // 상세 목록 5개는 탭 1개로 접음(선택 탭만 표시)
    const ovl = ["up", "over", "rdec", "churn", "prio"].includes(S.ui.ovList) ? S.ui.ovList : "up";
    h += `<section class="ov-sec"><div class="card ovl"><div class="card-head"><h3>상세 목록</h3><span class="muted">탭을 눌러 바꿈</span></div><div class="tabs" id="ovList" role="tablist"><button type="button" data-ovl="up" class="${ovl === "up" ? "on" : ""}">이번 달·다음 달 예정 ${cnt(d.upcoming_count)}</button><button type="button" data-ovl="over" class="${ovl === "over" ? "on" : ""}">예정월 경과 ${cnt(d.overdue_count)}</button><button type="button" data-ovl="rdec" class="${ovl === "rdec" ? "on" : ""}">재계약 감액 예상 ${cnt(d.renewal_decrease_count)}</button><button type="button" data-ovl="churn" class="${ovl === "churn" ? "on" : ""}">해지확정 ${cnt(k.churn_count)}</button><button type="button" data-ovl="prio" class="${ovl === "prio" ? "on" : ""}">우선 확인 상위 20</button></div><div class="ovl-p" data-ovl="up" ${ovl === "up" ? "" : "hidden"}><div class="card"><div class="card-head"><h3>이번 달·다음 달 수주(재계약) 예정</h3><span class="link" data-drill='${esc(JSON.stringify({ scope: "in_progress", bucket: "이번 달" }))}'>이번 달 전체</span> <span class="link" data-drill='${esc(JSON.stringify({ scope: "in_progress", bucket: "다음 달" }))}'>다음 달 전체</span></div>
        <p class="desc">진행 중 ${cnt(d.upcoming_count)}건 · 수주년월을 예정월로 사용(업무 가정) · 상위 20건</p>${funnelTable(d.upcoming, { compact: true, maxH: 320 })}</div></div><div class="ovl-p" data-ovl="over" ${ovl === "over" ? "" : "hidden"}><div class="card"><div class="card-head"><h3>예정월 경과 사업</h3><span class="link" data-drill='${esc(JSON.stringify({ scope: "in_progress", bucket: "예정월 경과" }))}'>전체 ${cnt(d.overdue_count)}건</span></div>
        <p class="desc">진행 중이며 수주년월이 기준월보다 이전 → 수주 일정·현재 단계 확인</p>${funnelTable(d.overdue, { compact: true, maxH: 320 })}</div></div><div class="ovl-p" data-ovl="rdec" ${ovl === "rdec" ? "" : "hidden"}><div class="card"><div class="card-head"><h3>재계약 감액 예상</h3><span class="link" data-drill='${esc(JSON.stringify({ scope: "checks", code: "RENEWAL_DECREASE" }))}'>전체 ${cnt(d.renewal_decrease_count)}건</span></div>
        <p class="desc">R 진행 중 · 변경매출 &lt; 기존매출 또는 월매출합계 &lt; 0 → 감액 사유·방어 방안 확인</p>${funnelTable(d.renewal_decrease, { compact: true, maxH: 300 })}</div></div><div class="ovl-p" data-ovl="churn" ${ovl === "churn" ? "" : "hidden"}><div class="card"><div class="card-head"><h3>해지확정 (기존매출 큰 순)</h3><span class="link" data-drill='${esc(JSON.stringify({ status: ["해지확정"], period: "win_ym" }))}'>전체 ${cnt(k.churn_count)}건</span></div>
        <p class="desc">수주년월 기간 내 · 해지월로 단정하지 않음 · 확정 ACR 합계에서 제외</p>${funnelTable(d.churn, { compact: true, maxH: 300 })}</div></div><div class="ovl-p" data-ovl="prio" ${ovl === "prio" ? "" : "hidden"}><div class="card" style="margin-top:14px"><div class="card-head"><h3>우선 확인할 Funnel (상위 20)</h3><span class="link" data-goto="priority">전체 목록</span></div>
      <p class="desc">여러 사유에 해당하면 한 행에 모아 표시 · 등급 → 사유 수 → 금액 순</p>${funnelTable(d.priority, { priority: true, maxH: 520 })}</div></div></div></section>
    ${basisBlock(d.basis)}${rulesBlock(d.rules)}`;
    $("view").innerHTML = h;
    document.querySelectorAll("#ovList [data-ovl]").forEach((bt) => bt.addEventListener("click", () => {
      S.ui.ovList = bt.dataset.ovl; store.set("ui", S.ui);
      document.querySelectorAll("#ovList [data-ovl]").forEach((x) => x.classList.toggle("on", x === bt));
      document.querySelectorAll(".ovl-p").forEach((x) => { x.hidden = x.dataset.ovl !== bt.dataset.ovl; });
    }));
    bindPeriodToolbar("ovPer");
    bindTargets(tgYear);
    if (S.tgData) tgBarChart("tgChart", S.tgData.labels, S.tgData.tgt, S.tgData.act);
    acrMonthlyChart("ovChart", ovRows, ["A", "C", "R", "ACR"], (m, key) => openDetail({ scope: "acr", rev_month: m.ym, acr_type: key && ["A", "C", "R"].includes(key) ? [key] : undefined }), ovRef);
  }

  // ------------------------------------------------------------ 페이지: 수주·Funnel
  async function pageFunnel() {
    const j = await api("/view/funnel", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const o = d.outcome, wt = d.weighted_total;
    // 진행 중 A/C 일정 카드: 기간 중(조회기간 시작월~종료월) · 예정월 경과 · 예정월 미입력
    const sp = d.sched_period, ymL = (v) => `${String(v).slice(0, 4)}-${String(v).slice(4)}`;
    const sb = (k) => d.schedule.find((s) => s.bucket === k) || { count: 0, amount: { total: 0 } };
    const pAC = { scope: "in_progress", acr_type: ["A", "C"] };
    let h = `<div class="grid kpis">
      ${kpiCard(`진행 중 A/C (기간 중)`, cnt(sp.in.count) + "건", `계약기간매출 ${amt(sp.in.amount.total)}<br>${ymL(sp.ym_from)}~${ymL(sp.ym_to)}${sp.in.overdue ? ` (경과 ${cnt(sp.in.overdue)}건 포함)` : ""}`, "", Object.assign({ period: "win_ym" }, pAC))}
      ${kpiCard("진행 중 A/C · 예정월 경과", cnt(sb("예정월 경과").count) + "건", `기준월 이전 · 계약기간매출 ${amt(sb("예정월 경과").amount.total)}`, "neg", Object.assign({ bucket: "예정월 경과" }, pAC))}
      ${kpiCard("진행 중 A/C · 예정월 미입력", cnt(sb("예정월 미입력").count) + "건", `계약기간매출 ${amt(sb("예정월 미입력").amount.total)}`, "warn", Object.assign({ bucket: "예정월 미입력" }, pAC))}
    </div>
    ${tabsBlock("fn", [["stage", "① 단계 분포", `<div class="card"><h3>① 현재 단계 분포 (A/C)</h3><p class="desc">수주년월 기간 내 현재 상태 · 과거 단계 이력이 없어 전환율·체류기간은 산출하지 않음</p>
        <div class="chart-box short"><canvas id="stageChart"></canvas></div>
        <div class="table-wrap" style="margin-top:8px"><table class="t"><thead><tr><th>단계</th><th class="num">건수</th><th class="num">계약기간매출</th></tr></thead>
        <tbody>${d.stage.map((s) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ acr_type: ["A", "C"], status: [s.status], period: "win_ym" }))}'><td>${esc(s.status)}</td><td class="num">${cnt(s.count)}</td><td class="num">${amt(s.amount)}</td></tr>`).join("")}</tbody></table></div>
        <p class="desc" style="margin-top:10px"><b>R 단계</b> (월매출합계 = 재계약 증감)</p>
        <div class="table-wrap"><table class="t"><thead><tr><th>단계</th><th class="num">건수</th><th class="num">기존 월매출</th><th class="num">변경 월매출</th><th class="num">월매출 증감</th></tr></thead>
        <tbody>${d.stage_r.map((s) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ acr_type: ["R"], status: [s.status], period: "win_ym" }))}'><td>${esc(s.status)}</td><td class="num">${cnt(s.count)}</td><td class="num">${amt(s.prev)}</td><td class="num">${amt(s.new)}</td><td class="num">${amt(s.monthly)}</td></tr>`).join("")}</tbody></table></div></div>`], ["check", "③ 확인 조건 · ⑤ 종결 결과", `<div class="card"><h3>③ 확인 필요 조건</h3><p class="desc">자동 오류 확정·수정이 아니라 확인 대상 표시입니다.</p>
        <div class="table-wrap"><table class="t"><thead><tr><th>조건</th><th>권장 행동</th><th class="num">건수</th></tr></thead>
        <tbody>${d.check_counts.map((c) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ scope: "checks", acr_type: ["A", "C"], code: c.code }))}'><td>${esc(c.label)}</td><td class="wrap">${esc(c.action)}</td><td class="num">${cnt(c.count)}</td></tr>`).join("")}</tbody></table></div>
        <h3 style="margin-top:16px">⑤ 종결 결과 (A/C, 수주년월 기준 현재 종결상태)</h3>
        <div class="table-wrap"><table class="t"><thead><tr><th>구분</th><th class="num">Win</th><th class="num">Lose</th><th class="num">Drop</th><th class="num">승패 결정 건 기준 수주율</th></tr></thead>
        <tbody><tr><td>A+C</td><td class="num">${cnt(o.win)}</td><td class="num">${cnt(o.lose)}</td><td class="num">${cnt(o.drop)}</td><td class="num">${pct(o.win_rate)}</td></tr>
        ${o.by_type.map((t) => `<tr><td>${typeTag(t.type)}</td><td class="num">${cnt(t.win)}</td><td class="num">${cnt(t.lose)}</td><td class="num">${cnt(t.drop)}</td><td class="num">${pct(t.win_rate)}</td></tr>`).join("")}
        <tr><td class="muted">계약기간매출</td><td class="num">${amt(o.win_amount)}</td><td class="num">${amt(o.lose_amount)}</td><td class="num">${amt(o.drop_amount)}</td><td></td></tr></tbody></table></div>
        <p class="desc" style="margin-top:6px">수주율 = Win/(Win+Lose), Drop은 분모 제외 · 분모 0이면 산출 불가 · 과거 시점 수주율 아님</p></div>`], ["prob", "④ 수주 가능성", `<div class="card"><h3>④ 수주 가능성 (진행 중 A/C)</h3>
      <p class="desc">‘수주(재계약)가능성’의 명시적 0~100% 값만 사용, 변환 실패는 미확인. 가중 추정 = 계약기간매출 × 입력 가능성 — 통계적 예측이 아닌 입력값 기반 참고치이며 원본 ‘수주가능매출’과 동일시하지 않음.</p>
      <div class="table-wrap"><table class="t"><thead><tr><th>가능성 구간</th><th class="num">건수</th><th class="num">계약기간매출 합계</th><th class="num">양수 건</th><th class="num">0 건</th><th class="num">음수 건(금액)</th><th class="num">참고용 가중 추정</th></tr></thead>
      <tbody>${d.prob_bins.map((b) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ scope: "in_progress", acr_type: ["A", "C"], prob_bin: b.bin }))}'><td>${esc(b.bin)}</td><td class="num">${cnt(b.count)}</td><td class="num">${amt(b.amount.total)}</td><td class="num">${cnt(b.amount.pos_count)}</td><td class="num">${cnt(b.amount.zero_count)}</td><td class="num">${cnt(b.amount.neg_count)} (${amt(b.amount.negative)})</td><td class="num">${b.bin === "미확인" ? '<span class="muted">산출 불가</span>' : amt(b.weighted)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="6">가중 추정 합계 — 양수 / 음수 (상계하지 않음) · 포함 ${wt.included}건, 제외 ${wt.excluded}건</td><td class="num">${amt(wt.positive)} / ${amt(wt.negative)}</td></tr></tfoot></table></div></div>`], ["reason", "승패·Drop 사유", `<div class="grid cols-3"><div class="card">${reasonTable(d.reasons.win, "Win 승패사유")}</div><div class="card">${reasonTable(d.reasons.lose, "Lose 승패사유")}</div><div class="card">${reasonTable(d.reasons.drop, "Drop 세부사유")}</div></div>`], ["list", "확인 필요 Funnel 50", `<div class="card"><h3>확인 필요 Funnel (A/C, 상위 50)</h3>${funnelTable(d.checks, { priority: true, maxH: 520 })}</div>`]])}
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

  // 수주연도별 기여매출: 조회기간(시작월~종료월)에 발생한 기여매출을 수주연도로 나눔. 합계 = 위 요약 카드
  function acrByWinCard(rows) {
    if (!rows || !rows.length) return "";
    const tot = rows.find((r) => r.total) || { ACR: 0 };
    const tr = rows.map((r) => `<tr class="${r.total ? "tg-strong bw-tot" : ""}"><td>${esc(r.label)}</td><td class="num">${amt(r.A)}</td><td class="num">${amt(r.C)}</td><td class="num">${amt(r.AC)}</td><td class="num">${amt(r.R_renew)}</td><td class="num">${amt(r.R_churn)}</td><td class="num">${amt(r.R)}</td><td class="num"><b>${amt(r.ACR)}</b></td><td class="num">${tot.ACR ? `${((r.ACR / tot.ACR) * 100).toFixed(1)}%` : "—"}</td></tr>`).join("");
    return `<div class="card" style="margin-top:14px"><div class="card-head"><h3>수주연도별 기여매출 <span class="h-period">${esc(S.f.ym_from)}~${esc(S.f.ym_to)} 발생분 · 수주연도 무관 합계를 수주연도로 나눔</span></h3><span class="unit">단위 ${esc(unitName())}</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>수주연도</th><th class="num">A</th><th class="num">C</th><th class="num">A+C</th><th class="num">R 재계약 증감</th><th class="num">R 해지 감소</th><th class="num">R 증감</th><th class="num">A+C+R</th><th class="num">A+C+R 비중</th></tr></thead><tbody>${tr}</tbody></table></div>
      <p class="desc" style="margin-top:6px">합계 = 위 요약 카드(조회기간 기여매출). 불러온 파일에 있는 계약만 포함 — 파일에 없는 이전 연도 수주 계약은 빠집니다.</p></div>`;
  }

  // 연도별 기여매출 표: 선택한 수주연도 건이 연도별(1~12월)로 발생시키는 기여매출
  function acrYearsCard(ay, win, span) {
    if (!ay || ay.empty) return "";
    const info = (x) => `<span class="info-i" title="${esc(x)}" tabindex="0" aria-label="${esc(x)}">i</span>`;
    const ymL = (v) => `${String(v).slice(0, 4)}-${String(v).slice(4)}`;
    const wins = [0].concat(ay.available_win_years || []);
    const t = ay.total || {};
    const rows = (ay.years || []).map((r) => `<tr><td><b>${r.year}년</b></td><td class="muted">${ymL(r.ym_from)}~${ymL(r.ym_to)}</td><td class="num">${amt(r.A)}</td><td class="num">${amt(r.C)}</td><td class="num">${amt(r.AC)}</td><td class="num">${amt(r.R)}</td><td class="num"><b>${amt(r.ACR)}</b></td><td class="num">${cnt(r.funnels)}</td></tr>`).join("");
    return `<div class="card ay-card" style="margin-top:14px"><div class="card-head"><h3>연도별 기여매출 <span class="h-period">${win ? `${win}년 수주 건` : "전체 수주 건"} · ${span === "5y" ? "수주연도부터 5년" : "조회기간 연도별"}</span> ${info(`선택한 수주연도(수주년월)의 확정 건이 각 연도 1~12월에 발생시키는 기여매출 · ${ay.mode === "term" ? "계약기간 반영" : "매출개시월 기준"} · A+C+R = A + C + R 증감(재계약 증감 + 해지 감소) · ‘조회기간 연도별’은 왼쪽 시작월~종료월의 연도로 나누고 그 기간으로 자름`)}</h3><span class="unit">단위 ${esc(unitName())}</span></div>
      <div class="toolbar ay-tools"><span class="muted">수주연도</span><span class="seg-light">${wins.map((w) => `<button type="button" data-ay-win="${w}" class="${w === win ? "on" : ""}">${w ? `${w}년` : "전체"}</button>`).join("")}</span>
        <span class="muted">표시 기간</span><span class="seg-light"><button type="button" data-ay-span="5y" class="${span === "5y" ? "on" : ""}">수주연도부터 5년</button><button type="button" data-ay-span="period" class="${span === "period" ? "on" : ""}">조회기간 연도별</button></span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>연도</th><th>기간</th><th class="num">A</th><th class="num">C</th><th class="num">A+C</th><th class="num">R 증감</th><th class="num">A+C+R</th><th class="num">고유 Funnel</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">자료 없음</td></tr>'}</tbody>
      <tfoot><tr><td>합계</td><td></td><td class="num">${amt(t.A)}</td><td class="num">${amt(t.C)}</td><td class="num">${amt(t.AC)}</td><td class="num">${amt(t.R)}</td><td class="num"><b>${amt(t.ACR)}</b></td><td></td></tr></tfoot></table></div>
      <p class="desc" style="margin-top:6px">예: 수주연도 2025년 + ‘수주연도부터 5년’ → 2025~2029년. 왼쪽 기간을 2025-01~2027-12로 두고 ‘조회기간 연도별’ → 2025·2026·2027년. 불러온 파일에 있는 수주연도만 고를 수 있습니다.</p></div>`;
  }

  // ACR 수주 2026년 목표(억원, 사용자 제공·공개 가능 수치): 구분별 [1Q, 2Q, 3Q, 4Q, 1H, 2H, 연간] — 2026년 수주(A+C)에만 적용
  const ORDER_TARGETS = { 2026: {
    all: { "담당 전체": [239.8697, 199.9039, 185.1093, 183.3412, 439.7736, 368.4506, 808.2242],
      "공공고객팀": [85.6678, 71.3943, 66.1105, 65.479, 157.062, 131.5895, 288.6515], "중부기업고객팀": [39.4072, 32.8414, 30.4108, 30.1203, 72.2485, 60.5312, 132.7797],
      "서부기업고객팀": [39.4072, 32.8414, 30.4108, 30.1203, 72.2485, 60.5312, 132.7797], "동부기업고객1팀": [35.9805, 29.9856, 27.7664, 27.5012, 65.966, 55.2676, 121.2336],
      "동부기업고객2팀": [39.4072, 32.8414, 30.4108, 30.1203, 72.2485, 60.5312, 132.7797] },
    leased: { "담당 전체": [130.9489, 142.8534, 134.3502, 130.0986, 273.8023, 264.4488, 538.2512],
      "공공고객팀": [46.7675, 51.0191, 47.9822, 46.4638, 97.7865, 94.446, 192.2326], "중부기업고객팀": [21.513, 23.4688, 22.0718, 21.3733, 44.9818, 43.4452, 88.427],
      "서부기업고객팀": [21.513, 23.4688, 22.0718, 21.3733, 44.9818, 43.4452, 88.427], "동부기업고객1팀": [19.6423, 21.428, 20.1525, 19.5148, 41.0704, 39.6673, 80.7377],
      "동부기업고객2팀": [21.513, 23.4688, 22.0718, 21.3733, 44.9818, 43.4452, 88.427] } } };
  const OT_PERIODS = [["1Q", 1, 3], ["2Q", 4, 6], ["3Q", 7, 9], ["4Q", 10, 12], ["1H", 1, 6], ["2H", 7, 12], ["연간", 1, 12]];
  async function orderTargetCard(year) {
    const up = (store.get("orderTargets", {}) || {})[year];
    const tg = up || ORDER_TARGETS[year]; if (!tg) return "";
    const prod = S.ui.otProd === "leased" && tg.leased ? "leased" : "all", T = tg[prod];
    const srcTxt = up ? "목표: 불러온 목표 파일" : "목표: 기본값(공개용 예시) · 종합 현황 ‘목표 엑셀 불러오기’로 바꿀 수 있음";
    const base = Object.assign(totF(), { teams: [], ams: [], products: [], total_year: year, product_group: prod });
    const names = Object.keys(T);
    const views = await Promise.all(names.map((nm) => api("/view/total", { filters: Object.assign({}, base, nm === "담당 전체" ? {} : { teams: [nm] }) }).then((x) => x.data || {})));
    const srcWon = UNIT_WON[S.ui.srcUnit] || 1e6, toSrc = (eok) => eok * 1e8 / srcWon;
    const baseYm = Number(String(S.f.base_date || "").slice(0, 7).replace("-", "")) || 0;
    const sumM = (v, m1, m2) => (v.empty ? 0 : (v.monthly || []).filter((m) => m.ym % 100 >= m1 && m.ym % 100 <= m2).reduce((a, m) => a + (m.AC || 0), 0));
    const n0 = (x) => fmtNum(conv(x), 0).replace(/<[^>]+>/g, "");
    const cell = (act, t, m1) => {
      const g = toSrc(t), r = g ? act / g : null, future = baseYm && year * 100 + m1 > baseYm;
      return `<td class="num ot-c${future ? " ot-future" : ""}"><span class="ot-frac">${n0(act)}/${n0(g)}</span><b class="ot-pct ${r >= 1 ? "ot-ok" : r < 0.7 ? "ot-low" : ""}">${r == null ? "—" : `${(r * 100).toFixed(0)}%`}</b></td>`;
    };
    const rows = names.map((nm, i) => `<tr class="${nm === "담당 전체" ? "tg-strong" : ""}"><td>${esc(nm)}</td>${OT_PERIODS.map(([lb, m1, m2], k) => cell(sumM(views[i], m1, m2), T[nm][k], m1)).join("")}</tr>`).join("");
    // 막대그래프 데이터(목표·실적, 단위 = 원본 단위) — drawOtChart가 그림
    S.otData = { names, periods: OT_PERIODS.map(([lb]) => lb),
      act: names.map((nm, i) => OT_PERIODS.map(([lb, m1, m2]) => sumM(views[i], m1, m2))),
      tgt: names.map((nm) => OT_PERIODS.map((p, k) => toSrc(T[nm][k]))),
      future: OT_PERIODS.map(([lb, m1]) => !!(baseYm && year * 100 + m1 > baseYm)) };
    const view = S.ui.otView === "org" ? "org" : "period";
    const org = names.includes(S.ui.otOrg) ? S.ui.otOrg : names[0];
    const per = OT_PERIODS.some(([lb]) => lb === S.ui.otPer) ? S.ui.otPer : "연간";
    const seg = (id, items, cur) => `<span class="seg-light" id="${id}">${items.map((v) => `<button type="button" data-v="${esc(v)}" class="${v === cur ? "on" : ""}">${esc(v)}</button>`).join("")}</span>`;
    return `<div class="card ot-card" style="margin-top:16px"><div class="card-head"><h3>${year}년 수주(A+C) 목표 대비 달성율 <span class="h-period">실적/목표 달성율 · 분기·반기·연간</span> <span class="ot-src${up ? " up" : ""}">${esc(srcTxt)}</span></h3>
      <span class="seg-light" id="otProd"><button type="button" data-v="all" class="${prod === "all" ? "on" : ""}">전체 상품</button><button type="button" data-v="leased" class="${prod === "leased" ? "on" : ""}">전용회선</button></span></div>
      <div class="toolbar ot-bar"><span class="seg-light" id="otView"><button type="button" data-v="period" class="${view === "period" ? "on" : ""}">기간별(조직 1개)</button><button type="button" data-v="org" class="${view === "org" ? "on" : ""}">조직별(기간 1개)</button></span>
        ${view === "period" ? seg("otOrg", names, org) : seg("otPer", OT_PERIODS.map(([lb]) => lb), per)}</div>
      <div class="chart-box ot-chart"><canvas id="otChart" role="img" aria-label="${year}년 수주 목표 대비 실적 막대그래프"></canvas></div>
      <p class="desc ot-legend"><i class="ot-sw t"></i>목표 <i class="ot-sw a"></i>실적 <i class="ot-sw f"></i>기준일 이후(진행 중) · 막대 위 % = 달성율(100% 이상 초록, 70% 미만 빨강)</p>
      <details class="ot-tbl"><summary>표로 보기(실적/목표 · 달성율)</summary>
      <div class="table-wrap"><table class="t ot-t"><thead><tr><th>구분</th>${OT_PERIODS.map(([lb]) => `<th class="num">${lb}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></details>
      <p class="desc" style="margin-top:6px">실적 = ${year}년 수주(A+C) 계약기간매출(수주년월 기준${totExcl() ? ", 중대형퍼널제외=Y 제외" : ""}) · 목표 = ${year}년 수주 목표(억원 → 1억원 = 100백만원) · 단위 ${esc(unitName())} · 기준일 이후 분기는 흐리게. 팀·AM 필터와 무관.</p></div>`;
  }  // 목표 대비 달성율 막대그래프: 기간별(선택 조직의 1Q~연간) 또는 조직별(선택 기간의 담당·팀)
  // 목표·실적 막대그래프 공용(목표 회색, 실적 주황, 막대 위 달성율 %) — 값은 원본 단위
  function tgBarChart(id, labels, tgt, act, fut) {
    if (!$(id)) return;
    fut = fut || labels.map(() => false);
    const rates = act.map((a, k) => (tgt[k] ? a / tgt[k] : null));
    const cA = css("--series-c", "#d9690b"), cT = css("--muted", "#6b7280"), ok = css("--ok", "#15803d"), neg = css("--neg", "#c81e1e"), ink = css("--text", "#111827");
    const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + a : c);
    const ymax = Math.max(1, ...act.map(conv), ...tgt.map((v) => conv(v || 0))) * 1.15;
    const pctPlugin = { id: "tgPct", afterDatasetsDraw(ch) {
      const m = ch.getDatasetMeta(1), m0 = ch.getDatasetMeta(0), cx = ch.ctx; if (!m || m.hidden) return;
      cx.save(); cx.textAlign = "center"; cx.font = `700 12px ${getComputedStyle(document.body).fontFamily}`;
      m.data.forEach((bar, k) => { const r = rates[k]; if (r == null) return; cx.fillStyle = r >= 1 ? ok : r < 0.7 ? neg : ink; cx.fillText(`${Math.round(r * 100)}%`, bar.x, Math.min(bar.y, m0.data[k] ? m0.data[k].y : bar.y) - 6); });
      cx.restore(); } };
    chart(id, { type: "bar", plugins: [pctPlugin],
      data: { labels, datasets: [
        { label: "목표", data: tgt.map((v) => (v == null ? null : conv(v))), backgroundColor: alpha(cT, "55"), borderColor: cT, borderWidth: 1, borderRadius: 3, maxBarThickness: 38 },
        { label: "실적", data: act.map(conv), backgroundColor: fut.map((x) => (x ? alpha(cA, "59") : cA)), borderColor: cA, borderWidth: 1, borderRadius: 3, maxBarThickness: 38 } ] },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? "목표 없음" : fmtNum(c.parsed.y, 0).replace(/<[^>]+>/g, "")}`, footer: (it) => { const r = rates[it[0].dataIndex]; return r == null ? "" : `달성율 ${(r * 100).toFixed(1)}%`; } } } },
        scales: { y: { beginAtZero: true, suggestedMax: ymax, title: { display: true, text: `금액 (${unitName()})` }, ticks: { callback: (v) => fmtNum(v, 0).replace(/<[^>]+>/g, "") } }, x: { grid: { display: false } } } } });
  }
  // 목표 대비 달성율 막대그래프: 기간별(선택 조직의 1Q~연간) 또는 조직별(선택 기간의 담당·팀)
  function drawOtChart() {
    const D = S.otData; if (!D || !$("otChart")) return;
    const byOrg = S.ui.otView === "org";
    const oi = Math.max(0, D.names.indexOf(S.ui.otOrg));
    const pk = D.periods.indexOf(S.ui.otPer) >= 0 ? D.periods.indexOf(S.ui.otPer) : D.periods.length - 1;
    tgBarChart("otChart", byOrg ? D.names : D.periods,
      byOrg ? D.names.map((n, i) => D.tgt[i][pk]) : D.tgt[oi],
      byOrg ? D.names.map((n, i) => D.act[i][pk]) : D.act[oi],
      byOrg ? D.names.map(() => D.future[pk]) : D.future);
  }



  // ------------------------------------------------------------ 페이지: ACR 수주(기여매출)
  async function pageAcr() {
    const j = await api("/view/acr", { filters: S.f });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const t = d.totals, ser = S.ui.acrSeries;
    const term = d.mode === "term";
    const lbl = term ? "기간 합계(월별 추정값 합)" : "매출개시월 기준 합계";
    const orgRows = netRows(S.f.level === "am" ? d.by_am : d.by_team);
    // 월별 차트·기간별 표 = 신규 발생분(매출개시월). 카드·조직별 표·누적은 현재 기준(계약기간 반영) 합계
    const svA = term ? (await api("/view/acr", { filters: Object.assign({}, S.f, { mode: "start" }) })).data : null;
    const newM = term ? ((svA || {}).monthly || []) : d.monthly;
    // 연도별 기여매출: 수주연도(0 = 전체) × 표시 기간(수주연도부터 5년 | 조회기간 연도별)
    const ayWin = Number(S.ui.ayWin) || 0, aySpan = S.ui.aySpan === "period" ? "period" : "5y";
    const ayBase = ayWin || Math.floor(Number(String(S.f.ym_from).replace("-", "")) / 100);
    const ayF = aySpan === "5y" ? { acr_win_year: ayWin, acr_years: [0, 1, 2, 3, 4].map((i) => ayBase + i), acr_clip: false } : { acr_win_year: ayWin, acr_years: [], acr_clip: true };
    const ay = (await api("/view/acr_years", { filters: Object.assign({}, S.f, ayF) })).data || {};
    // 수주연도별 기여매출(조회기간 전체): 연도마다 같은 계산(acr_years, 조회기간으로 자름)을 수주연도로 나눠 합계
    const byWin = [];
    if (!ay.empty) {
      const pf = (w) => api("/view/acr_years", { filters: Object.assign({}, S.f, { acr_win_year: w, acr_years: [], acr_clip: true }) }).then((x) => (x.data && x.data.total) || null);
      const wins = ay.available_win_years || [];
      const [tAll, ...tw] = await Promise.all([pf(0)].concat(wins.map(pf)));
      wins.forEach((w, i) => { if (tw[i]) byWin.push(Object.assign({ label: `${w}년 수주` }, tw[i])); });
      if (tAll) {
        const rest = {}; ["A", "C", "AC", "R_renew", "R_churn", "R", "ACR"].forEach((k) => { rest[k] = tAll[k] - byWin.reduce((a, r) => a + r[k], 0); });
        if (Math.abs(rest.A) + Math.abs(rest.C) + Math.abs(rest.R) > 0.05) byWin.push(Object.assign({ label: "수주년월 미입력" }, rest));
        byWin.push(Object.assign({ label: "합계", total: true }, tAll));
      }
    }
    const pRows = aggPeriods(netRows(newM), perOf(), false), pPool = poolOf(pRows);
    const cRows = aggPeriods(netRows(d.monthly), perOf(), false);
    const acrRef = term ? { label: "A+C+R 매출(월증가)", rows: cRows } : null;
    // 누적매출 = 조회기간 합계(기준·기간을 카드 아래에 표기)
    const kb = esc(`${lbl} · ${S.f.ym_from}~${S.f.ym_to}`);
    // 시안(2026-11): Hero(A+C+R) + A · C · R 증감 · A+C 5장, 설명 2줄, 기준은 섹션 머리 1줄, R 재계약은 참고 줄
    const rc = d.r_change || {}, rtA = rc.retention || { amount: null }, chA = rc.churn || { amount: 0, funnels: 0, excluded: {} };
    const exA = Object.values(chA.excluded || {}).reduce((x, y) => x + y, 0);
    const rdA = rtA.amount === null ? t.R : rtA.amount - rtA.prev_amount;  // 재계약 증감(상품 선택 시 상품 슬롯 증감)
    const rcA = rdA + chA.amount;
    let h = `<div class="ov-h" style="margin-top:16px"><h3>요약 <span class="h-period">${esc(lbl)} · ${esc(S.f.ym_from)}~${esc(S.f.ym_to)}</span> <span class="info-i" title="${esc(`${d.mode_label} — ${d.basis["주의"]} · A+C+R = A + C + R 증감(재계약 증감 + 해지 감소)${exA ? ` · 해지 계산 제외 ${exA}건` : ""}`)}" tabindex="0">i</span></h3><span class="unit">단위 ${esc(unitName())}</span></div>
    <div class="strip five">
      ${kpiCard("A+C+R. 기여매출", amt(t.A + t.C + rcA), `<span class="row"><span>A+C ${amt(t.AC)} + R 증감 ${amt(rcA)}</span><span>고유 ${cnt(t.funnels)}건</span></span><div class="mini" aria-hidden="true"><span style="width:${t.AC > 0 && t.A > 0 ? (t.A / t.AC * 100).toFixed(1) : 0}%;background:var(--series-a)"></span><span style="width:${t.AC > 0 && t.C > 0 ? (t.C / t.AC * 100).toFixed(1) : 0}%;background:var(--series-c)"></span></div>` + recLink(d), "hero", { scope: "acr" })}
      ${kpiCard("A. 기여매출", amt(t.A), `<span class="row"><span>${cnt(t.funnels_A)}건</span><span>A+C 중 ${t.AC > 0 ? (t.A / t.AC * 100).toFixed(1) + "%" : "—"}</span></span>`, "a", { scope: "acr", acr_type: ["A"] })}
      ${kpiCard("C. 기여매출", amt(t.C), `<span class="row"><span>${cnt(t.funnels_C)}건</span><span>A+C 중 ${t.AC > 0 ? (t.C / t.AC * 100).toFixed(1) + "%" : "—"}</span></span>`, "c", { scope: "acr", acr_type: ["C"] })}
      ${kpiCard("R. 증감", amt(rcA), rCardMeta(d.r_split, rdA, chA.amount, chA.funnels), "neg", { status: ["해지확정"], period: "rev_ym" })}
      ${kpiCard("A+C. 기여매출", amt(t.AC), `<span class="row"><span>${cnt(t.funnels_A + t.funnels_C)}건</span></span>`, "", { scope: "acr", acr_type: ["A", "C"] })}
    </div>
    ${genStrip(t.AC, t.funnels_A + t.funnels_C, rtA, `R = 재계약 후 매출(감소분 반영) · ${lbl}`)}
    <p class="ov-ref">고유 Funnel 수는 월별 반복 반영 횟수가 아님 · R. 발생매출은 R. 증감(기여매출)과 달리 재계약 후 매출 전체입니다.</p>${recBox(d)}${rSplitLine(d)}
    ${acrByWinCard(byWin)}
    ${acrYearsCard(ay, ayWin, aySpan)}
    ${Object.keys(d.excluded).length ? `<div class="notice warn">확정 조건이지만 이 지표에서 제외: ${Object.entries(d.excluded).map(([r, n]) => `${esc(r)} ${n}건`).join(", ")} <span class="link" data-drill='${esc(JSON.stringify({ scope: "acr_excluded" }))}'>목록 보기</span></div>` : ""}
    <div class="card" style="margin-top:14px"><div class="card-head"><h3>${(PERIODS.find((x) => x[0] === perOf()) || PERIODS[0])[1]} 신규 발생 매출</h3>${periodToolbar("acrPer")}
      <div class="legend" id="serSel">${["A", "C", "R", "AC", "ACR"].map((k) => `<label><input type="checkbox" value="${k}" ${ser.includes(k) ? "checked" : ""}><i style="background:${COLORS[k]}"></i>${SERIES_LABEL[k]}</label>`).join("")}</div></div>
      <p class="desc">막대=A·C·R, 선=합산 · 그 기간에 매출이 새로 시작된 건${term ? " · 굵은 녹색 선=A+C+R 매출(월증가): 그 기간에 실제 발생하는 매출 전체(카드 합계 기준)" : ""} · 단위 ${esc(unitName())} · 월별 보기에서 클릭 → 그 달에 매출이 시작된 Funnel</p>
      <div class="chart-box tall"><canvas id="acrChart"></canvas></div></div>
    ${tabsBlock("acr", [["period", "기간별 표", `<div class="card"><div class="card-head"><h3>기간별 표</h3><span class="muted">신규 발생분${term ? " · 기간 합은 카드(계약기간 반영 합계)와 다름" : ""}</span></div>${periodTable(pRows, pPool, { first: "기간", drill: (x) => ({ scope: "acr", rev_month: x.ym }), fLabel: "고유 Funnel" })}</div>`], ["org", "조직별 표", `<div class="card"><h3>조직별 표 (${S.f.level === "am" ? "AM" : "팀"})</h3><p class="desc">집계 수준 ‘AM’ 선택 시 AM별 · 조직별 합계는 담당 전체와 일치</p>
      <div class="table-wrap" style="max-height:520px"><table class="t"><thead><tr><th>${S.f.level === "am" ? "AM(팀)" : "팀"}</th><th class="num">A</th><th class="num">C</th><th class="num">R 증감</th><th class="num">A+C</th><th class="num">A+C+R</th><th class="num">고유 Funnel</th><th class="num">R 음수 건수</th><th class="num">R 음수 금액</th></tr></thead>
      <tbody>${orgRows.map((r) => `<tr class="clickable" data-drill='${esc(JSON.stringify(S.f.level === "am" ? { scope: "acr", am_key: r.key } : { scope: "acr", team: r.key }))}'><td>${esc(r.am ? `${r.am} (${r.team})` : r.team)}</td><td class="num">${amt(r.A)}</td><td class="num">${amt(r.C)}</td><td class="num">${amt(r.R)}</td><td class="num">${amt(r.AC)}</td><td class="num"><b>${amt(r.ACR)}</b></td><td class="num">${cnt(r.funnels)}</td><td class="num">${cnt(r.r_neg_count)}</td><td class="num">${amt(r.r_neg_amount)}</td></tr>`).join("") || '<tr><td colspan="9" class="muted">자료 없음</td></tr>'}</tbody></table></div></div>`], ["cmp", "팀·AM 비교 차트", `<div class="grid cols-2">
      <div class="card"><h3>팀별 비교</h3><p class="desc">${esc(lbl)} · 단위 ${esc(unitName())}</p><div class="chart-box"><canvas id="teamChart"></canvas></div></div>
      <div class="card"><h3>AM별 비교 (A+C+R 상위 20)</h3><p class="desc">${esc(lbl)}</p><div class="chart-box tall"><canvas id="amChart"></canvas></div></div>
    </div>`], ["cum", "누적 차트", `<div class="card"><h3>누적 (${esc(d.basis["누적"])})</h3><p class="desc">월별 금액과 축을 분리한 별도 차트 · 단위 ${esc(unitName())}</p><div class="chart-box"><canvas id="cumChart"></canvas></div></div>`]])}
    ${basisBlock(d.basis)}`;
    $("view").innerHTML = h;
    bindPeriodToolbar("acrPer");
    document.querySelectorAll("[data-ay-win]").forEach((b) => b.addEventListener("click", () => { S.ui.ayWin = Number(b.dataset.ayWin); store.set("ui", S.ui); render(); }));
    document.querySelectorAll("[data-ay-span]").forEach((b) => b.addEventListener("click", () => { S.ui.aySpan = b.dataset.aySpan; store.set("ui", S.ui); render(); }));
    acrMonthlyChart("acrChart", pRows, ser, (m, key) => openDetail({ scope: "acr", rev_month: m.ym, acr_type: key && ["A", "C", "R"].includes(key) ? [key] : undefined }), acrRef);
    const cumDs = ser.map((k) => ({ label: `누적 ${SERIES_LABEL[k]}`, data: cRows.map((m) => conv(m.cum[k])), borderColor: COLORS[k], backgroundColor: COLORS[k], borderWidth: 2, pointRadius: 2, tension: 0 }));
    chart("cumChart", { type: "line", data: { labels: cRows.map((m) => m.label), datasets: cumDs },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: tooltipAmt } } }, scales: { y: { title: { display: true, text: `누적 금액 (${unitName()})` }, grid: zeroGrid }, x: { grid: { display: false } } } } });
    const orgBar = (id, rows, labelFn, horizontal) => {
      const dsets = ["A", "C", "R"].map((k) => ({ label: SERIES_LABEL[k], data: rows.map((r) => conv(r[k])), backgroundColor: COLORS[k], borderRadius: 2, maxBarThickness: 16 }));
      chart(id, { type: "bar", data: { labels: rows.map(labelFn), datasets: dsets },
        options: { indexAxis: horizontal ? "y" : "x", maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtNum(horizontal ? ctx.parsed.x : ctx.parsed.y).replace(/<[^>]+>/g, "")}` } } },
          scales: horizontal ? { x: { title: { display: true, text: unitName() }, grid: zeroGrid }, y: { grid: { display: false }, ticks: { autoSkip: false } } } : { y: { title: { display: true, text: unitName() }, grid: zeroGrid }, x: { grid: { display: false } } },
          onClick: (e, els) => { if (els.length) { const r = rows[els[0].index]; openDetail(r.am ? { scope: "acr", am_key: r.key } : { scope: "acr", team: r.key }); } } } });
    };
    orgBar("teamChart", netRows(d.by_team), (r) => r.team, false);
    orgBar("amChart", netRows(d.by_am).slice(0, 20), (r) => `${r.am} (${r.team})`, true);
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
    // 가능성 구간 4색(주황 제외): 30%이하 적 · 30~69% 노랑 · 70~89% 파랑 · 90~100% 녹색
    const PSG = [["30%이하", ["30%이하"], "--ps-1"], ["30~69%", ["30%이상", "40%이상", "50%이상", "60%이상"], "--ps-3"],
      ["70%이상", ["70%이상", "80%이상"], "--ps-4"], ["90%이상", ["90%이상", "100%이상"], "--ps-5"]];
    const pct_ = ["ALL", "A", "C", "R"].includes(S.ui.psChartType) ? S.ui.psChartType : "ALL";
    const cTypes = pct_ === "ALL" ? ["A", "C", "R"] : [pct_];
    let psSer = Array.isArray(S.ui.psSeries) ? S.ui.psSeries.slice() : PSG.map((g) => g[0]).concat(["합계"]);
    // 이전 5구간 선택(30%이상·50%이상)을 새 구간(30~69%)으로 이어받음
    if ((psSer.includes("30%이상") || psSer.includes("50%이상")) && !psSer.includes("30~69%")) psSer.push("30~69%");
    const mons = d.types.A.monthly.map((m) => ({ ym: m.ym, label: m.label }));
    const gsum = (i, bands) => cTypes.reduce((a, t) => a + bands.reduce((x, b) => x + (d.types[t].monthly[i].bands[b] || 0), 0), 0);
    const gData = PSG.map(([lb, bands]) => mons.map((m, i) => gsum(i, bands)));
    const totData = mons.map((m, i) => gData.reduce((a, g) => a + g[i], 0));
    const unk = mons.reduce((a, m, i) => a + gsum(i, ["미확인"]), 0);
    let h = `<div class="card"><div class="card-head"><h3>월별 ACR 수주 증감액 (Pre-sales)</h3>
        <div class="legend" id="psSerSel">${PSG.map(([lb, , tok]) => `<label><input type="checkbox" value="${lb}" ${psSer.includes(lb) ? "checked" : ""}><i style="background:${css(tok, "#3a7fd0")}"></i>${lb}</label>`).join("")}
          <label><input type="checkbox" value="합계" ${psSer.includes("합계") ? "checked" : ""}><i style="background:${css("--ps-6", "#7c3aed")}"></i>합계</label></div></div>
      <div class="toolbar" style="margin:4px 0 6px"><span class="seg-light" id="psTypeSel">${[["ALL", "A+C+R"], ["A", "A"], ["C", "C"], ["R", "R"]].map(([k, l]) => `<button type="button" data-v="${k}" class="${k === pct_ ? "on" : ""}">${l}</button>`).join("")}</span>
        <span class="muted">진행 중(Pre Sales·제안완료) · 매출발생년월 기준 · 막대=가능성 구간, 선=합계 · 단위 ${esc(unitName())} · 클릭 → 해당 월·구간 Funnel</span></div>
      <p class="desc">30%이하=0~29%, 30~69%=30~69%, 70%이상=70~89%, 90%이상=90~100%.${unk ? ` 가능성 미확인 ${fmtNum(conv(unk)).replace(/<[^>]+>/g, "")}은 차트에서 제외.` : ""}</p>
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
      <div class="card"><h3>구간별 건수</h3><p class="desc">막대 색 = 가능성 구간 색(위 차트와 동일) · 진한 색 Pre Sales / 연한 색 제안완료</p><div class="chart-box"><canvas id="psCntChart"></canvas></div></div>
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
      <p class="desc" style="margin-top:6px">진행 중 기회의 현재 입력값입니다. 확정 ACR(기여매출)과 합산하지 않습니다.</p></div>
    ${basisBlock(d.basis)}`;
    $("view").innerHTML = h;
    document.querySelectorAll("[data-pstab]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); S.ui.psTab = b.dataset.pstab; store.set("ui", S.ui); render(); }));
    const visG = PSG.map((g, i) => [g, i]).filter(([g]) => psSer.includes(g[0]));
    const mds = visG.map(([g, i]) => ({ type: "bar", label: g[0], bands: g[1], data: gData[i].map(conv), backgroundColor: css(g[2], "#3a7fd0"), borderRadius: 3, maxBarThickness: 14, order: 2 }));
    if (psSer.includes("합계")) mds.push({ type: "line", label: "합계", bands: PSG.flatMap((g) => g[1]), data: totData.map(conv), borderColor: css("--ps-6", "#7c3aed"), backgroundColor: css("--ps-6", "#7c3aed"), borderWidth: 2, pointRadius: 3, tension: 0, order: 1 });
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
    // 구간 색(월별 차트와 동일): 30%이하 적 · 30~49% 주황 · 50~69% 노랑 · 70~89% 파랑 · 90~100% 녹색 · 미확인 회색
    const binCols = T.bins.map((b) => { const g = PSG.find((x) => x[1].includes(b.band)); return g ? css(g[2], "#3a7fd0") : css("--muted", "#94a3b8"); });
    const alphaOf = (c, a) => { const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim()); if (!m) return c; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
    chart("psChart", { type: "bar",
      data: { labels, datasets: [{ label: `${tab} 예상 월매출`, data: T.bins.map((b) => conv(b.monthly || 0)), backgroundColor: binCols, borderRadius: 3, maxBarThickness: 34 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltipAmt } } },
        scales: { y: { title: { display: true, text: `월매출 (${unitName()})` }, grid: zeroGrid }, x: { grid: { display: false } } },
        onClick: (e, els) => { if (els.length) openDetail({ scope: "in_progress", acr_type: [tab], period: "rev_ym", prob_band: labels[els[0].index] }); } } });
    chart("psCntChart", { type: "bar",
      data: { labels, datasets: [
        { label: "Pre Sales(진한 색)", data: T.bins.map((b) => b.presales), backgroundColor: binCols.map((c) => alphaOf(c, 1)), borderColor: binCols, borderWidth: 1, borderRadius: 2, maxBarThickness: 34, stack: "s" },
        { label: "제안완료(연한 색)", data: T.bins.map((b) => b.proposal), backgroundColor: binCols.map((c) => alphaOf(c, 0.45)), borderColor: binCols, borderWidth: 1, borderRadius: 2, maxBarThickness: 34, stack: "s" }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { generateLabels: () => [{ text: "Pre Sales(진한 색)", fillStyle: alphaOf(css("--text-2", "#888"), 1), strokeStyle: "transparent", fontColor: css("--text-2", "#555") }, { text: "제안완료(연한 색)", fillStyle: alphaOf(css("--text-2", "#888"), 0.4), strokeStyle: "transparent", fontColor: css("--text-2", "#555") }] } } },
        scales: { y: { stacked: true, title: { display: true, text: "건수" }, grid: zeroGrid, ticks: { precision: 0 } }, x: { stacked: true, grid: { display: false } } },
        onClick: (e, els) => { if (els.length) openDetail({ scope: "in_progress", acr_type: [tab], period: "rev_ym", prob_band: labels[els[0].index] }); } } });
  }

  // ------------------------------------------------------------ 페이지: ACR 수주(연도) — 구 ACR 수주(계약기간)
  async function pageTotal() {
    const j = await api("/view/total", { filters: totF() });
    setHeader(j);
    const d = j.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const t = d.totals, y = d.year, rf = d.r_ref;
    // 전년 동기 비교용: 같은 화면 계산을 직전 연도로 한 번 더 조회(계산 로직 동일)
    let prevMonthly = [];
    try { const jp = await api("/view/total", { filters: Object.assign(totF(), { total_year: y - 1 }) }); prevMonthly = (jp.data && jp.data.monthly) || []; } catch (e) { prevMonthly = []; }
    const baseYm = Number(String(S.f.base_date || "").slice(0, 7).replace("-", "")) || null;
    const otHtml = await orderTargetCard(y);
    const tRows = aggPeriods(netRows(d.monthly), perOf(), true, baseYm), tPool = poolOf(aggPeriods(netRows(prevMonthly), perOf(), true, baseYm).concat(tRows));
    // 메뉴·제목에 집계연도 표시
    $("pageTitle").textContent = "ACR 수주";
    document.querySelectorAll('[data-page="total"]').forEach((b) => { b.textContent = "ACR 수주"; });
    const years = Array.from(new Set((S.meta.options.years || []).concat([y]))).sort((a, b) => a - b);
    const kb = esc(`수주년월 ${y}-01~${y}-12 · 계약기간매출 합계`);
    const dk = (extra) => Object.assign({ scope: "total" }, extra || {});
    const orgRows = netRows(S.f.level === "am" ? d.by_am : d.by_team);
    // 시안(2026-11): 요약 5장 + 분기 표·팀별 표 나란히, R 재계약 참고는 접기
    const pSelT = S.f.products.length || S.f.product_group !== "all";
    const crT = d.churn_ref || { amount: 0, count: 0, excluded: 0 };
    const rdT = pSelT ? t.R : rf.new_total - rf.prev_total, rcT = rdT + crT.amount;
    const teamTop = netRows(d.by_team).slice().sort((x, z) => z.ACR - x.ACR), teamMax = Math.max(0, ...teamTop.map((r) => r.ACR));
    let h = `<div class="toolbar"><span class="muted">집계연도</span><span class="seg-light" id="tyearSel">${years.map((yy) => `<button type="button" data-v="${yy}" class="${yy === y ? "on" : ""}">${yy}년</button>`).join("")}</span>
        <label class="ml-toggle" title="원본 ‘중대형퍼널제외’ 열이 Y인 건을 ACR 수주 실적에서 뺌(종합 현황·우리 팀 실적의 ACR 수주도 같은 기준)"><input type="checkbox" id="totExclML" ${totExcl() || S.f.excl_midlarge ? "checked" : ""} ${S.f.excl_midlarge ? "disabled" : ""}> 중대형퍼널제외=Y 제외</label>
        <span class="muted">확정 건(A·C=Win, R=재계약완료)의 계약 전체 기간 매출을 수주월에 합산</span></div>
    <div class="ov-h" style="margin-top:16px"><h3>요약 <span class="h-period">수주년월 ${y}-01~${y}-12 · 계약기간매출 합계</span> <span class="info-i" tabindex="0" title="${esc(`A+C+R = A + C + R 증감(재계약 증감 × 계약기간 + 해지 감소 × 계약기간)${crT.excluded ? ` · 해지 계산 제외 ${crT.excluded}건` : ""}${Object.keys(d.excluded).length ? ` · 집계 제외 ${Object.values(d.excluded).reduce((x, z) => x + z, 0)}건` : ""}`)}">i</span></h3><span class="unit">단위 ${esc(unitName())}</span></div>
    <div class="strip five ac-first">
      ${acCard(`${y}년 수주(A+C)`, y, t.AC, `${cnt(t.funnels_A + t.funnels_C)}건`, dk({ acr_type: ["A", "C"] }))}
      ${kpiCard("A+C+R. 매출", amt(t.A + t.C + rcT), `<span class="row"><span>A+C ${amt(t.AC)} + R 증감 ${amt(rcT)}</span><span>A+C ${cnt(t.funnels_A + t.funnels_C)}건</span></span><div class="mini" aria-hidden="true"><span style="width:${t.AC > 0 && t.A > 0 ? (t.A / t.AC * 100).toFixed(1) : 0}%;background:var(--series-a)"></span><span style="width:${t.AC > 0 && t.C > 0 ? (t.C / t.AC * 100).toFixed(1) : 0}%;background:var(--series-c)"></span></div>`, "hero", dk())}
      ${kpiCard("A. 수주", amt(t.A), `<span class="row"><span>${cnt(t.funnels_A)}건</span><span>A+C 중 ${t.AC > 0 ? (t.A / t.AC * 100).toFixed(1) + "%" : "—"}</span></span>`, "a", dk({ acr_type: ["A"] }))}
      ${kpiCard("C. 수주", amt(t.C), `<span class="row"><span>${cnt(t.funnels_C)}건</span><span>A+C 중 ${t.AC > 0 ? (t.C / t.AC * 100).toFixed(1) + "%" : "—"}</span></span>`, "c", dk({ acr_type: ["C"] }))}
      ${kpiCard("R. 증감", amt(rcT), rCardMeta(d.r_split, rdT, crT.amount, crT.count), "neg", { status: ["해지확정"], period: "win_ym" })}
    </div>
    ${rSplitLine(d)}
    ${Object.keys(d.excluded).length ? `<div class="notice warn">집계에서 제외: ${Object.entries(d.excluded).map(([k, v]) => `${esc(k)} ${v}건`).join(", ")}</div>` : ""}
    ${d.mismatch ? `<div class="notice warn">계약기간매출이 월매출합계 × 계약기간과 다른 건 ${d.mismatch}건 — 원본 계약기간매출 그대로 합산했습니다.</div>` : ""}
    ${otHtml}
    <div class="card" style="margin-top:16px"><div class="card-head"><h3>${(PERIODS.find((x) => x[0] === perOf()) || PERIODS[0])[1]} 추이 차트 (${y}년)</h3>${periodToolbar("totPer")}</div><p class="desc">막대 A·C 누적, R 증감은 0 아래, 선 A+C+R · 월별 보기에서 클릭 → 해당 월 Funnel</p>
      <div class="chart-box tall"><canvas id="totChart"></canvas></div></div>
    <div class="grid ov-split" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>${(PERIODS.find((x) => x[0] === perOf()) || PERIODS[0])[1]} 수주 (${y}년)</h3></div>${periodTable(tRows, tPool, { first: "수주 기간", drill: (x) => dk({ win_month: x.ym }), sumF: true, fLabel: "건수" })}</div>
      <div class="card"><div class="card-head"><h3>팀별 A+C+R</h3><span class="muted">큰 순 · 행 클릭 → 목록</span></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>팀</th><th class="num">A+C</th><th class="num">R 증감</th><th class="num">A+C+R</th><th style="min-width:80px"></th></tr></thead>
        <tbody>${teamTop.map((r) => `<tr class="clickable" data-drill='${esc(JSON.stringify(dk({ team: r.key })))}'><td>${esc(r.team)}</td><td class="num">${amt(r.AC)}</td><td class="num">${amt(r.R)}</td><td class="num"><b>${amt(r.ACR)}</b></td><td><div class="mini" style="margin:6px 0 0"><span style="width:${teamMax > 0 && r.ACR > 0 ? (r.ACR / teamMax * 100).toFixed(1) : 0}%;background:var(--primary)"></span></div></td></tr>`).join("") || '<tr><td colspan="5" class="muted">자료 없음</td></tr>'}</tbody></table></div></div>
    </div>
      <details class="card" style="margin-top:16px"><summary><b>R 재계약 참고</b> <span class="muted">(기존 계약총액 → 재계약 후, 펼치기)</span></summary><p class="desc">재계약완료 ${cnt(rf.count)}건 · 증액 ${cnt(rf.increase_count)} / 동일 ${cnt(rf.same_count)} / 감액 ${cnt(rf.decrease_count)}건</p>
        <div class="table-wrap"><table class="t"><tbody>
          <tr><td>기존 계약총액 (기존매출 × 계약기간)</td><td class="num">${amt(rf.prev_total)}</td></tr>
          <tr><td><b>재계약 후 계약총액 (변경매출 × 계약기간) = R. 재계약</b></td><td class="num"><b>${amt(rf.new_total)}</b></td></tr>
          <tr><td>증감 (재계약 후 − 기존, 계약기간 합계)</td><td class="num">${amt(rf.new_total - rf.prev_total)}</td></tr></tbody></table></div>
        <p class="desc" style="margin-top:6px">R. 재계약은 재계약으로 확보한 매출(변경매출)의 계약기간 합계이며 A+C+R에 포함됩니다. 증감은 기존 계약 대비 늘거나 줄어든 금액입니다. 상품 선택 시에는 R이 상품별 증감 기준이라 위 표와 다를 수 있습니다.</p></details>
    <div class="card" style="margin-top:14px"><h3>조직별 (${S.f.level === "am" ? "AM" : "팀"})</h3><p class="desc">사이드바 ‘집계 수준’을 AM으로 바꾸면 AM별 · 조직별 합계 = 담당 전체</p>
      <div class="table-wrap" style="max-height:520px"><table class="t"><thead><tr><th>${S.f.level === "am" ? "AM(팀)" : "팀"}</th><th class="num">A</th><th class="num">C</th><th class="num">R 증감</th><th class="num">A+C</th><th class="num">A+C+R</th><th class="num">건수</th><th class="num" title="변경매출 &lt; 기존매출">R 감액 건수</th></tr></thead>
      <tbody>${orgRows.map((r) => `<tr class="clickable" data-drill='${esc(JSON.stringify(dk(S.f.level === "am" ? { am_key: r.key } : { team: r.key })))}'><td>${esc(r.am ? `${r.am} (${r.team})` : r.team)}</td><td class="num">${amt(r.A)}</td><td class="num">${amt(r.C)}</td><td class="num">${amt(r.R)}</td><td class="num">${amt(r.AC)}</td><td class="num"><b>${amt(r.ACR)}</b></td><td class="num">${cnt(r.funnels)}</td><td class="num">${cnt(r.r_neg_count)}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">자료 없음</td></tr>'}</tbody>
      <tfoot><tr><td>담당 합계</td><td class="num">${amt(t.A)}</td><td class="num">${amt(t.C)}</td><td class="num">${amt(t.RC)}</td><td class="num">${amt(t.AC)}</td><td class="num">${amt(t.ACRN)}</td><td class="num">${cnt(t.funnels)}</td><td></td></tr></tfoot></table></div></div>
    ${basisBlock(d.basis)}`;
    $("view").innerHTML = h;
    bindPeriodToolbar("totPer");
    acrMonthlyChart("totChart", tRows, ["A", "C", "R", "ACR"], (m, key) => openDetail(dk({ win_month: m.ym, acr_type: key && ["A", "C", "R"].includes(key) ? [key] : undefined })));
    document.querySelectorAll("#tyearSel button").forEach((b) => b.addEventListener("click", () => { S.f.total_year = Number(b.dataset.v); store.set("filters", S.f); render(); }));
    const mlT = $("totExclML"); if (mlT) mlT.addEventListener("change", () => { S.ui.totExclML = mlT.checked; store.set("ui", S.ui); render(); });
    document.querySelectorAll("#otProd button").forEach((b) => b.addEventListener("click", () => { S.ui.otProd = b.dataset.v; store.set("ui", S.ui); render(); }));
    [["otView", "otView"], ["otOrg", "otOrg"], ["otPer", "otPer"]].forEach(([id, key]) => document.querySelectorAll(`#${id} button`).forEach((x) => x.addEventListener("click", () => { S.ui[key] = x.dataset.v; store.set("ui", S.ui); render(); })));
    drawOtChart();
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
    // 시안 규칙: 상단 요약 숫자 5개
    const tsum = (k2) => d.rows.reduce((x, r) => x + (r[k2] || 0), 0);
    const teamKpi = `<div class="grid kpis" style="margin-top:16px">
      ${kpiCard("A+C+R 기여매출", amt(tsum("acr_acr")), `A/C ${amt(tsum("acr_ac"))} + R 증감 ${amt(tsum("acr_rc"))}`, "hero", { scope: "acr" })}
      ${kpiCard("진행 중 A/C", cnt(tsum("prog_ac_count")) + "건", `계약기간매출 ${amt(tsum("prog_ac_amount"))}`, "", { scope: "in_progress", acr_type: ["A", "C"] })}
      ${kpiCard("예정월 경과", cnt(tsum("overdue")) + "건", "수주 일정·단계 확인", "warn", { scope: "in_progress", bucket: "예정월 경과" })}
      ${kpiCard("해지확정", cnt(tsum("churn")) + "건", "수주년월 기간 내", "neg", { acr_type: ["R"], status: ["해지확정"], period: "win_ym" })}
      ${kpiCard("확인 Funnel", cnt(tsum("check_funnels")) + "건", `높음 ${cnt(tsum("check_level1"))}건`, "warn", { scope: "checks" })}
    </div>`;
    let h = teamKpi + `<div class="notice info">집계 수준: <b>${isAm ? "AM" : "팀"}</b> (사이드바 ‘집계 수준’에서 AM 선택 시 AM별). 매출 순위와 확인 과제를 함께 보며, 목표·보유고객 자료가 없어 자동 성과등급은 만들지 않습니다.</div>
    <div class="card"><div class="card-head"><h3>${isAm ? "AM" : "팀"}별 표</h3><button type="button" class="btn small" data-colmore="teamTbl">열 더 보기</button></div><div class="table-wrap" style="max-height:640px"><table class="t core-team" id="teamTbl"><thead><tr>
      <th>${isAm ? "AM(팀)" : "팀"}</th><th class="num" title="조회기간 확정 A/C 월매출 증감액 합계">A/C 기여매출</th><th class="num" title="재계약완료 건의 재계약 후 월매출(변경매출) 합계 · A+C+R 미포함">R 재계약</th><th class="num" title="재계약 증감 + 해지 감소">R 증감</th><th class="num" title="A/C 기여매출 + R 증감">A+C+R 기여매출</th><th class="num">진행 중 A/C</th><th class="num" title="현재상황 Pre Sales·제안완료인 A/C의 계약기간매출 합계">Pre Sales/제안완료 계약기간 매출</th><th class="num">예정 임박</th><th class="num">예정월 경과</th>
      <th class="num">Win 건수</th><th class="num">Win 계약기간매출</th><th class="num">진행 중 재계약</th><th class="num">재계약 기존 월매출</th><th class="num">재계약 감액(완료)</th><th class="num">감액 예상(진행)</th>
      <th class="num">해지확정</th><th class="num">장기 미갱신</th><th class="num">갱신일 미입력</th><th class="num">필수정보 누락·오류</th><th class="num">확인 Funnel(높음)</th></tr></thead>
      <tbody>${d.rows.map((r) => `<tr><td>${esc(isAm ? `${r.am} (${r.team})` : r.team)}</td>
        <td class="num"><span class="link" data-drill='${esc(dk(r, { scope: "acr", acr_type: ["A", "C"] }))}'>${amt(r.acr_ac)}</span></td>
        <td class="num"><span class="link" data-drill='${esc(dk(r, { scope: "acr", acr_type: ["R"] }))}'>${amt(r.acr_r)}</span></td><td class="num">${amt(r.acr_rc)}</td><td class="num"><b>${amt(r.acr_acr)}</b></td>
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
      <tfoot><tr><td>합계</td><td class="num">${amt(sum("acr_ac"))}</td><td class="num">${amt(sum("acr_r"))}</td><td class="num">${amt(sum("acr_rc"))}</td><td class="num"><b>${amt(sum("acr_acr"))}</b></td><td class="num">${cnt(sum("prog_ac_count"))}</td><td class="num">${amt(sum("prog_ac_amount"))}</td><td class="num">${cnt(sum("imminent"))}</td><td class="num">${cnt(sum("overdue"))}</td><td class="num">${cnt(sum("win_count"))}</td><td class="num">${amt(sum("win_amount"))}</td><td class="num">${cnt(sum("prog_r_count"))}</td><td class="num">${amt(sum("prog_r_prev"))}</td><td class="num">${cnt(sum("renewal_decrease_done"))}</td><td class="num">${cnt(sum("renewal_decrease_expected"))}</td><td class="num">${cnt(sum("churn"))}</td><td class="num">${cnt(sum("stale"))}</td><td class="num">${cnt(sum("update_missing"))}</td><td class="num">${cnt(sum("missing_info"))}</td><td class="num">${cnt(sum("check_funnels"))}</td></tr></tfoot></table></div>
      <p class="desc" style="margin-top:6px">숫자를 클릭하면 해당 조건의 Funnel 목록으로 이동합니다. ‘확인 Funnel’ 괄호 안은 높음 등급 건수.</p></div>
    ${basisBlock(d.basis)}${rulesBlock(d.rules)}`;
    $("view").innerHTML = h;
  }

  // ------------------------------------------------------------ 페이지: 우리 팀 실적(팀장용)
  // 팀 이름은 이 브라우저(localStorage)에만 저장 · 계산은 기존 ACR 수주(연도)·팀·AM 관리 화면 계산을 그대로 사용
  function myTeam() { const t = store.get("myTeam", ""); return t && S.meta.options.teams.includes(t) ? t : ""; }
  function teamPicker(cur) {
    return `<div class="card"><h3>우리 팀 고르기</h3><p class="desc">한 번 고르면 다음부터 이 메뉴를 열 때 바로 팀 실적이 나옵니다. 팀 이름은 이 브라우저에만 저장되며 외부로 보내지 않습니다.</p>
      <div class="me-list" style="margin-top:10px">${S.meta.options.teams.map((t) => `<button type="button" class="btn small me-pick${t === cur ? " on" : ""}" data-myteam="${esc(t)}">${esc(t)}</button>`).join("")}</div></div>`;
  }
  function bindTeamPicker() {
    document.querySelectorAll("[data-myteam]").forEach((b) => b.addEventListener("click", () => { store.set("myTeam", b.dataset.myteam); store.set("myTeamPick", false); render(); }));
  }
  async function pageMyTeam() {
    const tm = myTeam();
    if (!tm || store.get("myTeamPick", false)) { setHeader(null); $("view").innerHTML = teamPicker(tm); bindTeamPicker(); return; }
    // 사이드바 필터를 우리 팀으로 맞춤(이전 선택은 보관 → '전체로 되돌리기')
    if (!(S.f.teams.length === 1 && S.f.teams[0] === tm && !S.f.ams.length)) {
      store.set("teamPrev", { teams: S.f.teams, ams: S.f.ams });
      S.f.teams = [tm]; S.f.ams = []; $("amSearch").value = ""; renderFilterInputs(); store.set("filters", S.f);
    }
    const fA = Object.assign({}, S.f, { level: "am" });
    const [jt, jm] = await Promise.all([api("/view/total", { filters: totF(fA) }), api("/view/team", { filters: fA })]);
    setHeader(jt);
    const d = jt.data, m = jm.data;
    if (d.empty) { $("view").innerHTML = emptyState(); return; }
    const t = d.totals, y = d.year, rf = d.r_ref;
    const pSel = S.f.products.length || S.f.product_group !== "all";
    const cr = d.churn_ref || { amount: 0, count: 0 };
    const rd = pSel ? t.R : rf.new_total - rf.prev_total, rc = rd + cr.amount, acrT = t.A + t.C + rc;
    const msum = (k) => (m.rows || []).reduce((x, r) => x + (r[k] || 0), 0);
    // AM별: ACR 수주(연도) + 기여매출·진행 현황 결합(AM 키 기준)
    const tot = {}; netRows(d.by_am).forEach((r) => { tot[r.key] = r; });
    const keys = Array.from(new Set(Object.keys(tot).concat((m.rows || []).map((r) => r.key))));
    const mm = {}; (m.rows || []).forEach((r) => { mm[r.key] = r; });
    const rows = keys.map((k) => {
      const a = tot[k] || {}, b = mm[k] || {};
      return { key: k, am: a.am || b.am || k.split("|")[1] || k, A: a.A || 0, C: a.C || 0, AC: a.AC || 0, RC: a.R || 0, ACR: a.ACR || 0, n: (a.funnels_A || 0) + (a.funnels_C || 0),
        acr_acr: b.acr_acr || 0, prog: b.prog_ac_count || 0, progAmt: b.prog_ac_amount || 0, overdue: b.overdue || 0, churn: b.churn || 0, chk: b.check_funnels || 0, chk1: b.check_level1 || 0, dec: b.renewal_decrease_expected || 0 };
    }).sort((x, z) => z.ACR - x.ACR);
    const sumR = (k) => rows.reduce((x, r) => x + r[k], 0);
    const maxAcr = Math.max(0, ...rows.map((r) => r.ACR));
    const dkT = (extra) => Object.assign({ scope: "total" }, extra || {});
    const lk = (v, drill, isAmt) => `<span class="link" data-drill='${esc(JSON.stringify(drill))}'>${isAmt ? amt(v) : cnt(v)}</span>`;
    const years = Array.from(new Set((S.meta.options.years || []).concat([y]))).sort((a, b) => a - b);
    const sub = (s) => `<span class="h-period">${s}</span>`;
    let h = `<div class="toolbar myteam-bar"><span class="myteam-name">${esc(tm)}</span><span class="muted">AM ${cnt(rows.length)}명</span>
        <button type="button" class="btn small" id="mtChange">팀 변경</button><button type="button" class="btn small" id="mtReset">전체로 되돌리기</button>
        <span class="muted">집계연도</span><span class="seg-light" id="mtYear">${years.map((yy) => `<button type="button" data-v="${yy}" class="${yy === y ? "on" : ""}">${yy}년</button>`).join("")}</span></div>
      <div class="notice info">왼쪽 필터의 팀이 <b>${esc(tm)}</b>(으)로 설정되어 다른 메뉴도 우리 팀 기준으로 보입니다. 전체를 보려면 ‘전체로 되돌리기’.</div>
      <section class="ov-sec"><div class="ov-h"><h3>ACR 수주 ${sub(`${y}년 수주 · 계약 전체 기간`)}</h3><span class="unit">단위 ${esc(unitName())}</span></div>
      <div class="strip five ac-first">
        ${acCard(`${y}년 수주(A+C)`, y, t.AC, `${cnt(t.funnels_A + t.funnels_C)}건`, dkT({ acr_type: ["A", "C"] }), [tm])}
        ${kpiCard("A+C+R 수주", amt(acrT), `<span class="row"><span>A+C ${amt(t.AC)} + R 증감 ${amt(rc)}</span></span>`, "hero", dkT())}
        ${kpiCard("A 수주", amt(t.A), `<span class="row"><span>${cnt(t.funnels_A)}건</span></span>`, "a", dkT({ acr_type: ["A"] }))}
        ${kpiCard("C 수주", amt(t.C), `<span class="row"><span>${cnt(t.funnels_C)}건</span></span>`, "c", dkT({ acr_type: ["C"] }))}
        ${kpiCard("R 증감", amt(rc), `<span class="row"><span>재계약 ${amt(rd)}</span></span><span class="row"><span>해지 ${amt(cr.amount)} · ${cnt(cr.count)}건</span></span>`, "neg", { status: ["해지확정"], period: "win_ym" })}
      </div></section>
      <section class="ov-sec"><div class="ov-h"><h3>기여매출 · 진행 현황 ${sub(`${esc(S.f.ym_from)}~${esc(S.f.ym_to)}`)}</h3><span class="unit">단위 ${esc(unitName())}</span></div>
      <div class="grid kpis">
        ${kpiCard("A+C+R 기여매출", amt(msum("acr_acr")), `A/C ${amt(msum("acr_ac"))} + R 증감 ${amt(msum("acr_rc"))}`, "hero", { scope: "acr" })}
        ${kpiCard("진행 중 A/C", cnt(msum("prog_ac_count")) + "건", `계약기간매출 ${amt(msum("prog_ac_amount"))}`, "", { scope: "in_progress", acr_type: ["A", "C"] })}
        ${kpiCard("예정월 경과", cnt(msum("overdue")) + "건", "수주 일정·단계 확인", "warn", { scope: "in_progress", bucket: "예정월 경과" })}
        ${kpiCard("해지확정", cnt(msum("churn")) + "건", "수주년월 기간 내", "neg", { acr_type: ["R"], status: ["해지확정"], period: "win_ym" })}
        ${kpiCard("확인 Funnel", cnt(msum("check_funnels")) + "건", `높음 ${cnt(msum("check_level1"))}건`, "warn", { scope: "checks" })}
      </div></section>
      <div class="card" style="margin-top:16px"><div class="card-head"><h3>AM별 실적 (${esc(tm)})</h3><span class="muted">A+C+R 수주 큰 순 · 숫자 클릭 → 해당 Funnel 목록</span></div>
      <div class="table-wrap" style="max-height:640px"><table class="t myteam-t"><thead><tr><th>AM</th><th class="num">A+C+R 수주(${y})</th><th>팀 내 비중</th><th class="num">A+C 수주</th><th class="num">R 증감</th><th class="num">A+C+R 기여매출</th><th class="num">진행 중 A/C</th><th class="num">예정월 경과</th><th class="num">감액 예상</th><th class="num">해지확정</th><th class="num">확인 Funnel(높음)</th></tr></thead>
      <tbody>${rows.map((r) => { const ak = { am_key: r.key }; const share = acrT > 0 ? r.ACR / acrT * 100 : 0;
        return `<tr><td><span class="link" data-drill='${esc(JSON.stringify(Object.assign({ scope: "total" }, ak)))}'>${esc(r.am)}</span></td>
        <td class="num"><b>${lk(r.ACR, dkT(ak), true)}</b></td>
        <td><span class="tm-bar"><span style="width:${maxAcr > 0 && r.ACR > 0 ? (r.ACR / maxAcr * 100).toFixed(1) : 0}%"></span></span> <span class="muted">${acrT > 0 ? share.toFixed(1) + "%" : "—"}</span></td>
        <td class="num">${lk(r.AC, dkT(Object.assign({ acr_type: ["A", "C"] }, ak)), true)}</td><td class="num">${amt(r.RC)}</td>
        <td class="num">${lk(r.acr_acr, Object.assign({ scope: "acr" }, ak), true)}</td>
        <td class="num">${lk(r.prog, Object.assign({ scope: "in_progress", acr_type: ["A", "C"] }, ak))}</td>
        <td class="num">${r.overdue ? lk(r.overdue, Object.assign({ scope: "in_progress", bucket: "예정월 경과" }, ak)) : "0"}</td>
        <td class="num">${r.dec ? lk(r.dec, Object.assign({ scope: "checks", code: "RENEWAL_DECREASE" }, ak)) : "0"}</td>
        <td class="num">${r.churn ? lk(r.churn, Object.assign({ acr_type: ["R"], status: ["해지확정"], period: "win_ym" }, ak)) : "0"}</td>
        <td class="num">${lk(r.chk, Object.assign({ scope: "checks" }, ak))} <span class="muted">(${cnt(r.chk1)})</span></td></tr>`; }).join("") || '<tr><td colspan="11" class="muted">자료 없음</td></tr>'}</tbody>
      <tfoot><tr><td>팀 합계</td><td class="num"><b>${amt(sumR("ACR"))}</b></td><td></td><td class="num">${amt(sumR("AC"))}</td><td class="num">${amt(sumR("RC"))}</td><td class="num">${amt(sumR("acr_acr"))}</td><td class="num">${cnt(sumR("prog"))}</td><td class="num">${cnt(sumR("overdue"))}</td><td class="num">${cnt(sumR("dec"))}</td><td class="num">${cnt(sumR("churn"))}</td><td class="num">${cnt(sumR("chk"))} <span class="muted">(${cnt(sumR("chk1"))})</span></td></tr></tfoot></table></div>
      <p class="desc" style="margin-top:6px">A+C+R 수주 = A + C + R 증감(재계약 증감 + 해지 감소, 계약기간 기준) · ACR 수주 화면(${y}년)과 같은 계산 · 기여매출·진행 현황은 팀·AM 관리 화면과 같은 계산(조회기간 ${esc(S.f.ym_from)}~${esc(S.f.ym_to)}).</p></div>`;
    $("view").innerHTML = h;
    $("mtChange").addEventListener("click", () => { store.set("myTeamPick", true); render(); });
    $("mtReset").addEventListener("click", () => {
      const p = store.get("teamPrev", null) || { teams: [], ams: [] };
      S.f.teams = (p.teams || []).filter((x) => x !== tm && S.meta.options.teams.includes(x));
      S.f.ams = (p.ams || []).filter((x) => S.meta.options.ams.some((a) => a.key === x));
      renderFilterInputs(); store.set("filters", S.f); go("overview");
    });
    document.querySelectorAll("#mtYear button").forEach((b) => b.addEventListener("click", () => { S.f.total_year = Number(b.dataset.v); store.set("filters", S.f); render(); }));
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
    // 수주율 표의 Win·Lose·Drop 건수는 계약기간매출 100만원 이상만(min_contract)
    const dW = (o, extra) => Object.assign({ acr_type: ["A", "C"], status: ["Win"], win_year: y, min_contract: true }, o, extra || {});
    const dS = (o, st, extra) => Object.assign({ acr_type: ["A", "C"], status: [st], win_year: y, min_contract: true }, o, extra || {});
    const dWall = (o, extra) => Object.assign({ acr_type: ["A", "C"], status: ["Win"], win_year: y }, o, extra || {});
    const dR = (o, st) => Object.assign({ acr_type: ["R"], status: [st], win_year: y }, o);
    const perfRow = (r, label, o) => `<tr><td>${label}</td>
      <td class="num">${lk(r.AC.win, dW(o))} <span class="muted">(사전 ${lk(r.AC.win_pre, dW(o, { reg_type: "사전" }))} / 사후 ${lk(r.AC.win_post, dW(o, { reg_type: "사후·당일" }))})</span></td>
      <td class="num">${lk(r.AC.lose, dS(o, "Lose"))}</td><td class="num">${lk(r.AC.drop, dS(o, "Drop"))}</td>
      <td class="num">${fr(r.AC.simple)}</td><td class="num">${fa(r.AC.simple_amt)}</td><td class="num">${fr(r.AC.pre)}</td><td class="num">${fa(r.AC.pre_amt)}</td><td class="num">${fr(r.A.pre)}</td><td class="num">${fr(r.C.pre)}</td>
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
    <div class="notice info">점검용 비교이며 AM 평가 점수가 아닙니다. ‘사전/사후 등록’은 수주가능성 변경이력의 첫 기록일로 판단한 <b>추정</b>입니다. 수주율은 사업기회 소멸(Drop)을 분모에 포함하고, Pre-sales 경유 수주율은 제외합니다. 두 수주율은 <b>계약기간매출 100만원 이상</b> 건만 계산하며(미만·미입력 A·C ${nf(t.AC.small_excluded)}건 제외), <b>건수 기준</b>과 <b>금액 기준</b>(계약기간매출 합계)을 함께 표시합니다.</div>
    <div class="grid kpis">
      ${kpiCard("수주율 (A·C)", t.AC.simple_amt.rate == null ? "-" : `<span class="v-amt">금액 ${pct(t.AC.simple_amt.rate)}</span><span class="v-cnt">건수 ${pct(t.AC.simple.rate)}</span>`, `금액 ${amt(t.AC.simple_amt.num)}÷${amt(t.AC.simple_amt.den)} · ${nf(t.AC.win)}÷${nf(t.AC.win + t.AC.lose + t.AC.drop)}건<br>A ${pct(t.A.simple_amt.rate)} · C ${pct(t.C.simple_amt.rate)} (금액)`, "", dW({}))}
      ${kpiCard("Pre-sales 경유 수주율", t.AC.pre_amt.rate == null ? "-" : `<span class="v-amt">금액 ${pct(t.AC.pre_amt.rate)}</span><span class="v-cnt">건수 ${pct(t.AC.pre.rate)}</span>`, `금액 ${amt(t.AC.pre_amt.num)}÷${amt(t.AC.pre_amt.den)} · ${nf(t.AC.win_pre)}÷${nf(t.AC.pre.den)}건<br>A ${pct(t.A.pre_amt.rate)} · C ${pct(t.C.pre_amt.rate)} (금액)`, "a", dW({}, { reg_type: "사전" }))}
      ${kpiCard("사전 등록률 (수주 3개월 전)", t.AC.reg.rate == null ? "-" : pct(t.AC.reg.rate), `90일 전 등록 ${nf(t.AC.reg.num)}÷${nf(t.AC.reg.den)}건<br>90일 미만 ${nf(t.AC.reg_pre_short)} · 사후 ${nf(t.AC.reg_post)}${t.AC.reg_nohist ? ` · 이력 없음 ${nf(t.AC.reg_nohist)}` : ""}건`, "warn", dWall({}, { reg_type: "사전", lead_min: 90 }))}
      ${kpiCard("리텐션 성공률 (건수)", t.ret_cnt.rate == null ? "-" : pct(t.ret_cnt.rate), `재계약완료 ${nf(t.r_done)} · 해지 ${nf(t.r_churn)}`, "r", dR({}, "해지확정"))}
      ${kpiCard("리텐션 성공률 (금액)", t.ret_amt.rate == null ? "-" : pct(t.ret_amt.rate), `기존 ${amt(t.ret_amt.den)} → 재계약 후 ${amt(t.ret_amt.num)}<br>해지 사유 1위: ${esc(t.churn_top || "-")}`, "r", dR({}, "재계약완료"))}
      ${kpiCard("신규(A) 비중", t.new_share.rate == null ? "-" : pct(t.new_share.rate), `확정 A·C Win 건수 기준 · 월매출 기준 ${pct(t.new_share_amt.rate)}`, "a", Object.assign(dW({}), { acr_type: ["A"] }))}
      ${kpiCard("30일 내 갱신률", t.fresh30.rate == null ? "-" : pct(t.fresh30.rate), `진행 중 ${nf(t.prog)}건 중 ${nf(t.fresh30.num)}건 · 활동 기록 최신성`, "", { scope: "in_progress" })}
      ${kpiCard("장기 미갱신 · 장기 체류", `${nf(t.stale_long)} · ${nf(t.long_stay)}건`, `저장 ${S.f.th.stale_long_days || 90}일 초과 · 최초 기록 ${S.f.th.long_stay_days || 365}일 초과(진행 중)`, "neg", { scope: "checks", code: ["STALE_LONG", "LONG_STAY"] })}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>${isAm ? "AM" : "팀"}별 수주율 비교</h3><p class="desc">수주율(건수·금액) vs Pre-sales 경유 수주율 · 계약기간매출 100만원 이상 · 분모 ${mn}건 이상만 표시 · ${y}년 수주년월</p><div class="chart-box ${isAm ? "tall" : ""}"><canvas id="pfWinChart"></canvas></div></div>
      <div class="card"><h3>${isAm ? "AM" : "팀"}별 리텐션 성공률</h3><p class="desc">건수 vs 금액 · 분모 ${mn}건 이상만 표시</p><div class="chart-box ${isAm ? "tall" : ""}"><canvas id="pfRetChart"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>성과: 수주율·리텐션 (${y}년 수주년월)</h3><p class="desc">숫자 클릭 → 해당 Funnel 목록</p>
      <div class="table-wrap" style="max-height:620px"><table class="t"><thead><tr><th>${isAm ? "AM(팀)" : "팀"}</th><th class="num" title="계약기간매출 100만원 이상">Win (사전/사후)</th><th class="num">Lose</th><th class="num">Drop</th>
        <th class="num">수주율(건수)</th><th class="num" title="Win 계약기간매출 ÷ (Win+Lose+Drop) 계약기간매출">수주율(금액)</th><th class="num">경유 수주율(건수)</th><th class="num" title="사전 Win 계약기간매출 ÷ (사전 Win+Lose) 계약기간매출">경유(금액)</th><th class="num">A 경유</th><th class="num">C 경유</th><th class="num">재계약완료</th><th class="num">해지</th>
        <th class="num">리텐션(건수)</th><th class="num">리텐션(금액)</th><th class="num">재계약 매출 증감률</th><th>해지 사유 1위</th><th class="num">신규(A) 비중</th></tr></thead>
      <tbody>${d.rows.map((r) => perfRow(r, orgLabel(r), orgD(r))).join("")}</tbody>
      <tfoot>${perfRow(t, "담당 합계", {})}</tfoot></table></div></div>
    <div class="card" style="margin-top:14px"><h3>활동성</h3><p class="desc">진행 중·갱신·체류는 현재(기준일 ${esc(S.f.base_date || "")}) 기준, 사전 등록률·리드타임·정확도는 ${y}년 수주년월 기준</p>
      <div class="table-wrap" style="max-height:620px"><table class="t"><thead><tr><th>${isAm ? "AM(팀)" : "팀"}</th><th class="num">진행 중</th><th class="num">30일 내 갱신률</th><th class="num">장기 미갱신(${S.f.th.stale_long_days || 90}일)</th><th class="num">장기 체류</th>
        <th class="num" title="수주 시점보다 90일(3개월) 이상 먼저 등록된 Win ÷ 이력 있는 Win">사전 등록률(3개월 전)</th><th class="num">리드타임(중앙값)</th><th class="num">Lose 중 가능성 70%↑</th></tr></thead>
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
    barChart("pfWinChart", okRows((r) => r.AC.simple.ok || r.AC.pre.ok), [["수주율(건수)", (r) => r.AC.simple, css("--primary", "#0f766e")], ["수주율(금액)", (r) => r.AC.simple_amt, css("--series-c", "#d9690b")], ["Pre-sales 경유 수주율", (r) => r.AC.pre, css("--series-a", "#2563eb")]]);
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
        <div class="table-wrap" style="max-height:600px"><table class="t" id="custTable"><thead><tr><th>고객사(표시명)</th><th>팀</th><th class="num">Funnel</th><th class="num">진행 중</th><th class="num" title="A·C 매출 + R 증감(재계약 증감 + 해지 감소)">A+C+R(통일 산식)</th><th class="num">해지확정</th></tr></thead>
        <tbody>${d.customers.map((c) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ customer: c.customer }))}' data-name="${esc(c.customer)}"><td>${esc(c.customer)}</td><td>${esc(c.teams)}</td><td class="num">${cnt(c.funnels)}</td><td class="num">${cnt(c.in_progress)}</td><td class="num">${amt(c.acr)}</td><td class="num">${cnt(c.churn)}</td></tr>`).join("")}</tbody></table></div>`;
    } else if (tab === "product") {
      body = `<div class="notice info">상품1~5와 월매출1~5를 짝으로 처리합니다. ACR은 해당 상품 슬롯의 월매출만 합산(Funnel 전체금액 반복 합산 없음). 계약기간매출은 ‘해당 상품을 보유한 Funnel 전체금액’이며 고유 Funnel당 1회 반영. 상품별 월매출 합계 ≠ 월매출합계 건: <span class="link" data-drill='${esc(JSON.stringify({ scope: "checks", code: "AMOUNT_MISMATCH" }))}'>${cnt(d.product_diff_count)}건</span></div>
        <div class="table-wrap" style="max-height:600px"><table class="t"><thead><tr><th>상품</th><th class="num">보유 Funnel</th><th class="num" title="확정 건 중 해당 상품 슬롯의 월매출만 합산(매출개시월 기준)">A 기여매출(상품별)</th><th class="num" title="확정 건 중 해당 상품 슬롯의 월매출만 합산(매출개시월 기준)">C 기여매출(상품별)</th><th class="num" title="확정 건 중 해당 상품 슬롯의 월매출만 합산(매출개시월 기준)">R 증감(상품별)</th><th class="num" title="확정 건 중 해당 상품 슬롯의 월매출만 합산(매출개시월 기준)">A+C+R 기여매출(상품별)</th><th class="num">ACR Funnel</th><th class="num">진행 중 A/C</th><th class="num">진행 중 계약기간매출(Funnel 전체)</th></tr></thead>
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
    await pageDetail(true);
    // 시안 규칙: 상단 요약(등급별 건수) — 같은 목록 조회를 등급 조건으로 1건씩만 받아 총건수만 사용
    try {
      const lv = await Promise.all([1, 2, 3].map((n) => api("/detail", { filters: S.f, drill: { scope: "checks", level: n }, page: 1, size: 1, sort: "level", desc: false, q: "" }).then((x) => (x.data && x.data.total) || 0)));
      const all = lv[0] + lv[1] + lv[2];
      const box = document.createElement("div");
      box.className = "grid kpis"; box.style.marginTop = "16px";
      box.innerHTML = kpiCard("우선 확인 Funnel", cnt(all) + "건", "규칙 1개 이상 해당 · 고유 Funnel", "hero", { scope: "checks" })
        + kpiCard("높음", cnt(lv[0]) + "건", "먼저 확인", "neg", { scope: "checks", level: 1 })
        + kpiCard("중간", cnt(lv[1]) + "건", "이번 주 확인", "warn", { scope: "checks", level: 2 })
        + kpiCard("낮음", cnt(lv[2]) + "건", "정기 점검", "", { scope: "checks", level: 3 });
      const v = $("view"); if (S.page === "priority" && v.firstChild) v.insertBefore(box, v.firstChild);
    } catch (e) { /* 요약 실패 시 목록만 표시 */ }
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
        <span class="seg-light" id="dPeriod" role="group" aria-label="기간 적용 기준">${[["", "기간 무관"], ["rev_ym", "매출발생년월 기간 내"], ["win_ym", "수주년월 기간 내"]].map(([v, l]) => `<button type="button" data-prd="${v}" class="${(dt.drill.period || "") === v ? "on" : ""}" aria-pressed="${(dt.drill.period || "") === v}">${l}</button>`).join("")}</span>
        <input type="text" id="dq" placeholder="목록 내 검색(고객사·Funnel·AM·팀)" value="${esc(dt.q)}">
        <button class="btn small" id="dqBtn" type="button">검색</button>
        ${isPriority ? "" : `<button class="btn small" id="dReset" type="button">조건 해제(전체)</button>`}
        <button class="btn small" type="button" data-colmore="detailTbl">열 더 보기</button>
        <button class="btn small primary" id="dExport" type="button">Excel 다운로드</button>
        <span class="muted">총 ${cnt(d.total)}건 · 금액 단위 ${esc(unitName())}</span></div>
      <p class="desc">조회기간 ${esc(S.f.ym_from)}~${esc(S.f.ym_to)} · ${dt.drill.period === "rev_ym" ? "매출발생년월이 조회기간 안인 건만 표시" : dt.drill.period === "win_ym" ? "수주년월이 조회기간 안인 건만 표시" : "기간과 관계없이 조건에 맞는 전체 건 표시"}${dt.drill.scope === "acr" && S.f.mode === "term" ? " · 확정 ACR(계약기간 반영) 목록은 매출발생년월이 조회기간 이전이어도 조회기간에 매출이 이어지는 계약을 포함합니다. 조회기간에 매출이 시작된 건만 보려면 ‘매출발생년월 기간 내’를 고르세요." : ""}</p>
      ${isPriority ? '<p class="desc">우선순위는 설명 가능한 조건 규칙으로 계산한 업무 확인 순서이며, 수주 확률이나 AM 평가점수가 아닙니다. 한 Funnel의 여러 사유는 한 행에 모아 표시합니다.</p>' : ""}
      <div class="table-wrap" style="max-height:68vh"><table class="t core-detail" id="detailTbl"><thead><tr>
        ${sortH("level", "우선순위")}<th>확인 사유</th><th>권장 확인 행동</th>${sortH("team", "팀")}${sortH("am", "AM")}${sortH("customer", "고객사")}${sortH("funnel_id", "Funnel번호")}
        ${sortH("acr_type", "유형")}${sortH("status", "현재상황")}${sortH("win_ym", "수주년월")}${sortH("rev_ym", "매출발생년월")}<th class="num">계약기간</th>
        ${sortH("monthly", "월매출합계", 1)}${sortH("contract_amt", "계약기간매출", 1)}${sortH("prev_monthly", "기존매출", 1)}${sortH("new_monthly", "변경매출", 1)}<th class="num">사유 금액(기준)</th>
        <th>수주 가능성</th><th>상품</th>${sortH("updated_at", "최근 갱신일")}<th>최초 등록일</th><th>등록 구분</th><th>ACR 포함</th><th>데이터 품질</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="clickable" data-row="${r.row}">
        <td>${lvTag(r.level) || '<span class="muted">-</span>'}</td><td class="wrap">${(r.checks || []).map((x) => `<span class="tag">${esc(x)}</span>`).join("") || '<span class="muted">-</span>'}</td><td class="wrap">${(r.actions || []).map(esc).join("<br>")}</td>
        <td>${esc(r.team)}</td><td>${esc(r.am)}</td><td>${esc(r.customer)}</td><td>${esc(r.funnel_id)}</td><td>${typeTag(r.acr_type)}</td><td>${esc(r.status)}</td>
        <td>${r.win_ym ? esc(r.win_ym) : '<span class="muted">미입력</span>'}</td><td>${r.rev_ym ? esc(r.rev_ym) : '<span class="muted">미입력</span>'}</td><td class="num">${esc(r.term == null ? "-" : r.term)}</td>
        <td class="num">${amt(r.monthly)}</td><td class="num">${amt(r.contract_amt)}</td><td class="num">${amt(r.prev_monthly)}</td><td class="num">${amt(r.new_monthly)}</td>
        <td class="num">${r.check_amount_basis && (r.checks || []).length ? `${amt(r.check_amount)}<br><span class="muted" style="font-size:13px">${esc(r.check_amount_basis)}</span>` : '<span class="muted">-</span>'}</td>
        <td>${esc(r.prob || "미확인")}</td><td class="wrap">${esc(r.products)}</td><td>${r.updated_at ? esc(r.updated_at) : '<span class="muted">갱신일 미입력</span>'}</td>
        <td>${r.first_reg ? esc(r.first_reg) : '<span class="muted">이력 없음</span>'}</td><td>${r.reg_type ? `<span class="chip ${r.reg_type === "사전" ? "ok" : r.reg_type === "사후·당일" ? "warn" : "gray"}">${esc(r.reg_type)}</span>` : '<span class="muted">-</span>'}</td>
        <td>${r.acr_included ? '<span class="chip ok">포함</span>' : `<span class="chip gray">제외</span><br><span class="muted" style="font-size:13px">${esc(r.acr_excl_reason || "")}</span>`}</td>
        <td class="wrap">${(r.issues || []).map((x) => `<span class="tag warn">${esc(x)}</span>`).join("") || '<span class="muted">-</span>'}${r.agg_excluded ? '<br><span class="neg">집계 제외</span>' : ""}</td></tr>`).join("") || '<tr><td colspan="24"><div class="state">해당 건 없음</div></td></tr>'}</tbody></table></div>
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
    if ($("dReset")) $("dReset").addEventListener("click", () => { dt.drill = dt.drill.period ? { period: dt.drill.period } : {}; dt.q = ""; dt.page = 1; rerun(); });
    document.querySelectorAll("#dPeriod [data-prd]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.prd) dt.drill.period = b.dataset.prd; else delete dt.drill.period;
      dt.page = 1; rerun();
    }));
    $("dExport").addEventListener("click", () => exportExcel(dt.drill, dt.q));
  }
  async function exportExcel(drill, q) {
    const dl = window.PSD_STANDALONE ? null : await getDownloads();
    let out;
    try { out = PSD.exportWorkbook(PSD.getDataset(), PSD.parseParams(S.f), drill || {}, q || ""); }
    catch (e) { toast("Excel 파일을 만들지 못했습니다: " + e.message, "neg"); return; }
    if (!dl) {
      if (window.PSD_STANDALONE) { // 파일로 연 단독 실행판: 브라우저 기본 다운로드
        const url = URL.createObjectURL(new Blob([out.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        const a = document.createElement("a"); a.href = url; a.download = out.filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast(`Excel 저장: ${out.filename} (${out.rows}건)`, "ok");
      } else toast("이 화면에서는 파일 저장을 지원하지 않습니다. claude.ai에서 이 페이지를 열어 다시 시도하세요.", "warn");
      return;
    }
    try {
      await dl.save({ filename: out.filename, data: new Blob([out.data]) });
      toast(`Excel 저장 완료: ${out.filename} (${out.rows}건)`, "ok");
    } catch (e) {
      const code = e && e.code;
      if (code === "declined") toast("저장을 취소했습니다.", "info");
      else if (code === "rate_limited") toast("저장 확인 창이 이미 열려 있습니다. 잠시 후 다시 누르세요.", "warn");
      else toast("이 화면에서는 파일 저장을 사용할 수 없습니다.", "warn");
    }
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
    const stored = await IDB.get();
    let h = `<div class="card"><h3>엑셀 선택</h3>
      <div class="steps"><span class="on">① 파일 선택</span><span id="st2">② 시트·헤더 확인 및 검증</span><span id="st3">③ 미리보기</span><span id="st4">④ 적용</span></div>
      <div class="upload-box">
        <p class="desc">‘유선Funnel조회’ 양식 .xlsx (최대 ${esc(S.meta.settings.MAX_UPLOAD_MB)}MB). 파일은 <b>이 브라우저 안에서만</b> 읽고 계산하며 어떤 서버로도 전송하지 않습니다. 검증에 실패하면 지금 보이는 데이터를 그대로 유지합니다.</p>
        <input type="file" id="upFile" accept=".xlsx"> <button class="btn primary" id="upBtn" type="button">검증</button>
        <label style="display:inline-flex;gap:6px;align-items:center;margin-left:8px;font-size:12.5px"><input type="checkbox" id="keepLocal"> 이 브라우저에 보관(다음에 열 때 자동 적용)</label>
        <div id="upResult"></div></div>
      <div class="toolbar" style="margin-top:10px">
        <span class="muted">${stored ? `이 브라우저 보관본: ${esc(stored.name)} · ${esc(stored.at)}` : "이 브라우저에 보관된 파일 없음"}</span>
        ${stored ? '<button class="btn small" id="delLocal" type="button">보관본 삭제</button>' : ""}
        ${window.PSD_BASE ? '<button class="btn small" id="useBase" type="button">기준 파일(내장)로 되돌리기</button>' : ""}
      </div>
      <p class="desc">보관본은 이 기기·이 브라우저에만 저장되며 다른 사람에게 보이지 않습니다. 공용 PC에서는 보관하지 마세요.</p></div>`;
    if (d.empty) h += `<div class="notice warn" style="margin-top:14px">현재 적용된 데이터가 없습니다. ${esc((d.meta && d.meta.reason) || "")}</div>`;
    else {
      if (d.meta.base) h += `<div class="notice info" style="margin-top:14px">아래는 페이지에 내장된 <b>기준 파일</b>의 품질 현황입니다. 계산에 쓰지 않는 ${(d.meta.excluded_columns || []).length}개 열(최근영업활동내용 등)은 내장하지 않았습니다.</div>`;
      h += qualityHtml(d);
    }
    $("view").innerHTML = h;
    $("upBtn").addEventListener("click", doUpload);
    if ($("delLocal")) $("delLocal").addEventListener("click", async () => { await IDB.del(); toast("이 브라우저 보관본을 삭제했습니다. 화면의 데이터는 새로 고치기 전까지 유지됩니다.", "ok"); go("data"); });
    if ($("useBase")) $("useBase").addEventListener("click", async () => { loadBase(); await loadMeta(true); toast("기준 파일(내장) 데이터로 전환했습니다.", "info"); go("overview"); });
  }
  function qualityHtml(d) {
    const q = d.quality, s = d.summary, m = d.meta;
    const ms = (m.merged_sheets || []);
    const mergedHtml = ms.length ? `<div class="notice info" style="margin-top:14px"><b>시트 ${ms.length}개를 합쳐 읽음</b> — ${ms.map((x) => `${esc(x.sheet)} ${cnt(x.rows)}건`).join(" · ")}${ms.some((x) => x.fixes && x.fixes.length) ? `<br>머리글 위치로 맞춤: ${ms.filter((x) => x.fixes && x.fixes.length).map((x) => `${esc(x.sheet)} ${x.fixes.map(esc).join(", ")}`).join(" / ")}` : ""}</div>` : "";
    return `${(q.warnings || []).map((w) => `<div class="notice neg" style="margin-top:14px"><b>원본 확인 필요</b> — ${esc(w)}</div>`).join("")}${mergedHtml}<div class="grid kpis" style="margin-top:14px">
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
    out.innerHTML = '<div class="state"><div class="spinner"></div>검증 중… (브라우저 안에서 계산)</div>';
    let buf;
    try { buf = await f.arrayBuffer(); } catch (e) { out.innerHTML = '<div class="notice neg">파일을 읽지 못했습니다. 다시 선택하세요.</div>'; return; }
    await new Promise((r) => setTimeout(r, 30));
    let j;
    try { j = PSD.stage(buf.slice(0), f.name); }
    catch (e) { out.innerHTML = `<div class="notice neg">검증 실패: ${esc(e.message)}<br>지금 보이는 데이터는 그대로 유지됩니다.</div>`; return; }
    $("st2").className = "on"; $("st3").className = "on";
    out.innerHTML = `<div class="notice ok">검증 통과 — 아래 미리보기를 확인한 뒤 적용하세요.</div>${qualityHtml({ quality: j.quality, meta: j.meta, summary: { source_rows: j.meta.row_count, in_scope_rows: j.quality.in_scope_rows, agg_excluded_rows: j.quality.agg_excluded_rows, missing_update_rows: "-", future_update_rows: "-" }, metrics: [] })}
      <div style="margin-top:12px"><button class="btn primary" id="applyUp" type="button">④ 적용</button> <span class="muted">적용 전까지 화면 데이터는 바뀌지 않습니다.</span></div>`;
    $("applyUp").addEventListener("click", async () => {
      try {
        const at = new Date().toLocaleString("ko-KR");
        const ds = PSD.apply(j.token, at);
        $("st4").className = "on";
        let kept = "";
        if ($("keepLocal") && $("keepLocal").checked) kept = (await IDB.put({ name: f.name, at, buf })) ? " · 이 브라우저에 보관함" : " · 브라우저 보관 실패(이번 화면에서만 사용)";
        await loadMeta(true);
        toast(`적용 완료: ${ds.meta.file_name} · ${ds.meta.row_count.toLocaleString("ko-KR")}건${kept}`, "ok");
        go("overview");
      } catch (e) { out.insertAdjacentHTML("beforeend", `<div class="notice neg">적용 실패: ${esc(e.message)} — 기존 데이터를 유지합니다.</div>`); }
    });
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
      h += `<h3>계산 위치 · 보안</h3><dl class="basis"><dt>계산</dt><dd>이 브라우저 안(엑셀을 서버로 전송하지 않음)</dd><dt>대상 본부</dt><dd>${esc(S.meta.settings.TARGET_HQ)}</dd><dt>공유 범위</dt><dd>각 열람자가 자기 엑셀을 직접 선택. 다른 사람의 데이터는 보이지 않음</dd><dt>필터</dt><dd>조회 범위 선택이며 접근 권한 통제가 아님</dd></dl>`;
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

  // ------------------------------------------------------------ 내 실적 바로가기
  // 내 이름(AM 키)은 이 브라우저(localStorage)에만 저장 · 외부 전송 없음
  function meKey() {
    const k = store.get("me", "");
    return k && S.meta && S.meta.options.ams.some((a) => a.key === k) ? k : "";
  }
  function meOn() { const k = meKey(); return !!k && S.f.ams.length === 1 && S.f.ams[0] === k; }
  function updateMeBtn() {
    const b = $("meBtn"); if (!b) return;
    const k = meKey(), a = k ? S.meta.options.ams.find((x) => x.key === k) : null;
    b.textContent = a ? (meOn() ? `내 실적 · ${a.am} ✓` : `내 실적 · ${a.am}`) : "내 실적";
    b.classList.toggle("on", meOn());
    b.title = a ? (meOn() ? "다시 누르면 이전 선택(전체 등)으로 돌아갑니다" : `${a.team} ${a.am} 실적만 보기`) : "처음 한 번 내 이름을 고르면 다음부터 한 번에 내 실적만 봅니다";
    const e = $("meEdit"); if (e) e.hidden = !a;
  }
  function applyMe(on) {
    const k = meKey();
    if (on && k) {
      if (!meOn()) store.set("mePrev", { teams: S.f.teams, ams: S.f.ams });
      S.f.teams = []; S.f.ams = [k];
    } else {
      const p = store.get("mePrev", null) || { teams: [], ams: [] };
      S.f.teams = (p.teams || []).filter((t) => S.meta.options.teams.includes(t));
      S.f.ams = (p.ams || []).filter((x) => x !== k && S.meta.options.ams.some((a) => a.key === x));
    }
    $("amSearch").value = "";
    renderFilterInputs(); store.set("filters", S.f); render();
  }
  function openMePicker() {
    $("modal").classList.add("open"); $("modalBg").classList.add("open");
    const cur = store.get("me", "");
    const draw = (q) => {
      let h = "", grp = null;
      S.meta.options.ams.filter((a) => !q || a.am.includes(q) || a.team.includes(q)).forEach((a) => {
        if (a.team !== grp) { grp = a.team; h += `<div class="me-grp">${esc(grp)}</div>`; }
        h += `<button type="button" class="btn small me-pick${a.key === cur ? " on" : ""}" data-me="${esc(a.key)}">${esc(a.am)}</button>`;
      });
      $("meList").innerHTML = h || '<p class="muted">해당 AM 없음</p>';
    };
    $("modalBody").innerHTML = `<h3 style="margin-top:0">내 실적 바로가기 · 내 이름 고르기</h3>
      <p class="desc">한 번 고르면 다음부터 상단 <b>내 실적</b> 버튼 한 번으로 모든 화면이 내 실적만 보여 줍니다. 이름은 이 브라우저에만 저장되며 외부로 보내지 않습니다.</p>
      <div class="side-row" style="margin:8px 0"><input type="text" id="meSearch" placeholder="이름 또는 팀 검색" style="width:100%"></div>
      <div id="meList" class="me-list"></div>
      ${cur ? '<p style="margin-top:12px"><button type="button" class="btn small" id="meForget">저장된 이름 지우기</button></p>' : ""}`;
    draw("");
    $("meSearch").addEventListener("input", (e) => draw(e.target.value.trim()));
    $("meSearch").focus();
    $("meList").addEventListener("click", (e) => {
      const p = e.target.closest("[data-me]"); if (!p) return;
      store.set("me", p.dataset.me); closeModal(); applyMe(true);
    });
    const fg = $("meForget");
    if (fg) fg.addEventListener("click", () => { const was = meOn(); store.set("me", ""); closeModal(); if (was) applyMe(false); else updateMeBtn(); });
  }

  // ------------------------------------------------------------ 라우팅
  const PAGES = { overview: pageOverview, funnel: pageFunnel, renewal: pageRenewal, acr: pageAcr, presales: pagePresales, total: pageTotal, team: pageTeam, myteam: pageMyTeam, perf: pagePerf, insight: pageInsight, priority: pagePriority, detail: () => pageDetail(false), data: pageData };
  const BASIS_VIEW = { overview: "overview", funnel: "funnel", renewal: "renewal", acr: "acr", presales: "presales", total: "total", team: "team", myteam: "team", perf: "perf", insight: "insight" };
  function go(page) {
    S.page = page;
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
    try { history.replaceState(null, "", "#" + page); } catch (e) { /* noop */ }
    S.hash = page;
    render();
    window.scrollTo(0, 0);
  }
  // 메뉴별 핵심 카드 강조(종합 현황은 화면 코드에서 직접 지정). 라벨 앞부분으로 찾고, 없으면 첫 카드
  const HERO_LABEL = { funnel: "진행 중 A/C (기간 중)", renewal: "재계약완료", acr: "A+C. 기여매출", presales: "A. 예상매출",
    total: /^\d{4}년 수주\(A\+C\)/, perf: "수주율", data: "원본 건수" };
  function applyHero() {
    const v = $("view"); v.dataset.page = S.page;
    // A/C/R 매출·기여매출 카드 이름도 유형 색 박스(A 파랑·C 노랑·R 주황)
    v.querySelectorAll(".kpi").forEach((c) => {
      const l = c.querySelector(".label"); if (!l || c.classList.contains("lbox")) return;
      const m = l.textContent.trim().match(/^([ACR])\.? (?:(?:기여)?매출|수주|재계약)$/);
      if (m) c.classList.add("lbox", "lbox-" + m[1]);
    });
    // 재계약·해지 관리: 나머지 카드 이름도 서로 다른 연한 색 박스(재계약완료는 강조 카드)
    const BOX_MAP = {
      renewal: [["진행 중 재계약", "ok"], ["재계약 매출 증감률", "info"], ["해지확정", "neg"]],
      funnel: [ ["진행 중 A/C · 예정월 경과", "neg"], ["진행 중 A/C · 예정월 미입력", "warn"]],
    };
    if (BOX_MAP[S.page]) {
      const RB = BOX_MAP[S.page];
      v.querySelectorAll(".kpi").forEach((c) => {
        const l = c.querySelector(".label"); if (!l || c.classList.contains("lbox")) return;
        const hit = RB.find(([w]) => l.textContent.trim().startsWith(w));
        if (hit) c.classList.add("lbox", "lbox-" + hit[1]);
      });
    }
    if (S.page === "overview" || !(S.page in HERO_LABEL)) return;
    const cards = Array.from(v.querySelectorAll(".kpi"));
    if (!cards.length || cards.some((c) => c.classList.contains("hero"))) return;
    const want = HERO_LABEL[S.page];
    const hit = cards.find((c) => { const l = c.querySelector(".label"); const tx = l ? l.textContent.trim() : ""; return want instanceof RegExp ? want.test(tx) : tx.startsWith(want); }) || cards[0];
    hit.classList.add("hero");
  }
  async function render() {
    destroyCharts();
    loading();
    $("pageTitle").textContent = PAGE_TITLES[S.page];
    S.last = { basisView: BASIS_VIEW[S.page] };
    $("view").dataset.page = S.page;
    try { await PAGES[S.page](); } catch (e) { errorState(e.message); }
    applyHero();
  }
  async function loadMeta(keepFilters) {
    S.meta = await api("/meta");
    const saved = store.get("filters", null);
    const def = defaultFilters();
    // 기본 기간이 바뀌면(버전 불일치) 저장된 화면의 조회기간을 새 기본값으로 교체
    if (saved && saved._dv !== S.meta.defaults.version) { delete saved.ym_from; delete saved.ym_to; }
    // ACR 기준 기본값 변경(매출개시월 → 계약기간 반영): 이전에 저장된 기준은 한 번 초기화
    // 2026-11: 기여매출 합계는 계약기간 반영(기간 안 개월 수 × 월매출), 월별 차트·기간별 표는 신규 발생분 — 이전 저장 기준은 한 번 초기화
    if (saved && saved._mv !== 4) { saved.mode = "term"; saved._mv = 4; }
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
    // 2026-11: 금액은 소수점 없이 표시(10,852.34 → 10,852) — 이전 저장 설정은 한 번 0자리로
    if (S.ui._decv !== 1) { S.ui.dec = 0; S.ui._decv = 1; }
    if (unitLocked()) S.ui.srcUnit = S.meta.unit.source_unit; // 확정 단위는 저장된 화면 설정보다 우선
    if (!UNIT_WON[S.ui.dispUnit]) S.ui.dispUnit = "백만원";
    renderFilterInputs();
  }

  // ------------------------------------------------------------ 이벤트
  function bind() {
    document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => {
      // 메뉴에서 '상세 목록'을 열면 조회기간(매출발생년월) 안의 건부터 보여 줌
      if (b.dataset.page === "detail") S.detail = { drill: { period: "rev_ym" }, page: 1, sort: "row", desc: false, q: "", size: S.detail.size || 50 };
      go(b.dataset.page);
    }));
    $("applyBtn").addEventListener("click", () => { readFilters(); render(); });
    // 기준일·기간·ACR 기준은 바꾸는 즉시 다시 계산('조회' 버튼 없이도 반영)
    ["f_base", "f_from", "f_to", "f_wfrom", "f_wto", "f_mode"].forEach((id) => $(id).addEventListener("change", () => { readFilters(); render(); }));
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
    $("meBtn").addEventListener("click", () => { if (!meKey()) openMePicker(); else applyMe(!meOn()); });
    $("meEdit").addEventListener("click", openMePicker);
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
      const recEl = e.target.closest("[data-rec]");
      if (recEl) {
        e.stopPropagation(); S.ui.recOpen = !S.ui.recOpen; store.set("ui", S.ui);
        const box = $("recBox"); if (box) { box.hidden = !S.ui.recOpen; if (S.ui.recOpen) box.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
        document.querySelectorAll("[data-rec]").forEach((x) => { x.textContent = `계약기간별 ${S.ui.recOpen ? "▴ 접기" : "▾ 보기"}`; x.setAttribute("aria-expanded", S.ui.recOpen ? "true" : "false"); });
        return;
      }
      const dEl = e.target.closest("[data-drill]");
      if (dEl) { e.stopPropagation(); try { openDetail(JSON.parse(dEl.dataset.drill)); } catch (err) { /* noop */ } return; }
      const gEl = e.target.closest("[data-goto]");
      if (gEl) { go(gEl.dataset.goto); return; }
      const rEl = e.target.closest("tr[data-row]");
      if (rEl) openRaw(rEl.dataset.row);
    });
    window.addEventListener("hashchange", () => { const h = (location.hash || "").replace("#", ""); if (PAGES[h] && h !== S.hash) go(h); });
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { refreshColors(); render(); });
      new MutationObserver(() => { refreshColors(); render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) { /* noop */ }
    $("view").addEventListener("click", (e) => {
      const tb = e.target.closest("button[data-tabgrp]");
      if (tb) {
        const g = tb.dataset.tabgrp, k = tb.dataset.tk;
        S.ui.tabsBy = Object.assign({}, S.ui.tabsBy, { [g]: k }); store.set("ui", S.ui);
        document.querySelectorAll(`button[data-tabgrp="${g}"]`).forEach((x) => { x.classList.toggle("on", x === tb); x.setAttribute("aria-selected", String(x === tb)); });
        document.querySelectorAll(`.tab-p[data-tabgrp="${g}"]`).forEach((x) => { x.hidden = x.dataset.tk !== k; });
        window.dispatchEvent(new Event("resize"));  // 숨겨져 있던 차트 크기 맞춤
        return;
      }
      const b = e.target.closest("[data-colmore]"); if (!b) return;
      const t = document.getElementById(b.dataset.colmore); if (!t) return;
      t.classList.toggle("show-all"); b.textContent = t.classList.contains("show-all") ? "핵심 열만" : "열 더 보기";
    });
    $("view").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches(".kpi[data-drill], .alert[data-drill], .alert[data-goto], [data-rec]")) e.target.click(); });
  }

  async function init() {
    bind();
    try {
      const stored = await IDB.get();
      let restored = false;
      if (stored && stored.buf) {
        try { PSD.loadParsed(PSD.readWorkbook(stored.buf), stored.name, stored.at + " (이 브라우저 보관본)"); restored = true; }
        catch (e) { toast("이 브라우저 보관본을 읽지 못해 기준 파일(내장) 데이터를 표시합니다.", "warn"); }
      }
      if (!restored && window.PSD_BASE) loadBase();
      const pv = document.querySelector(".privacy");
      if (pv && !window.PSD_BASE) pv.textContent = "엑셀 파일은 이 브라우저 안에서만 읽고 계산합니다. 어떤 서버로도 전송하지 않습니다. ‘데이터 관리’에서 유선Funnel조회 엑셀을 선택하세요.";
      await loadMeta(false);
    } catch (e) { errorState("초기 정보를 불러오지 못했습니다: " + e.message); return; }
    const h = (location.hash || "").replace("#", "");
    go(PAGES[h] ? h : (PSD.getDataset().empty ? "data" : "overview"));
  }
  new MutationObserver(() => applyHero()).observe($("view"), { childList: true });
  // 라이트·다크 전환(기본 다크, 2026-11 변경). 선택은 이 브라우저에만 저장
  (function themeInit() {
    let t = "dark";
    try { t = localStorage.getItem("psd-theme") || "dark"; } catch (e) { /* 저장 불가 시 기본값 */ }
    const apply = (v) => {
      document.documentElement.setAttribute("data-theme", v);
      refreshColors();  // 차트 색을 테마에 맞춰 즉시 갱신
      const b = $("themeBtn"); if (b) { b.textContent = v === "dark" ? "라이트 모드" : "다크 모드"; b.setAttribute("aria-pressed", String(v === "dark")); }
    };
    apply(t);
    const b = $("themeBtn");
    if (b) b.addEventListener("click", () => {
      const v = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(v); try { localStorage.setItem("psd-theme", v); } catch (e) { /* 무시 */ }
    });
  })();
  init();
})();
