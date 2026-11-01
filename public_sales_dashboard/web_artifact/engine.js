/* 공공영업 통합 대시보드 — 브라우저 계산 엔진
 * Python(data_loader.py · revenue.py · analytics.py)과 같은 기준을 JavaScript로 옮긴 것.
 * 엑셀은 열람자 브라우저 안에서만 읽고 계산하며 어떤 서버로도 전송하지 않는다.
 */
(function (root) {
  "use strict";

  // ================================================================ 설정 (config.py 대응)
  const CFG = {
    SOURCE_UNIT: "백만원",
    TARGET_HQ: "공공고객담당",
    MAX_UPLOAD_MB: 20,
    SHEET_NAME_PREFERRED: "유선Funnel조회",
    BUSINESS_DEFAULTS: { stale_days: 30, large_contract_amount: 1000, large_renewal_monthly: 30, imminent_months: 1, high_probability: 70 },
    COL: {
      customer: "고객사", win_ym: "수주년월", monthly: "월매출합계", status: "현재상황", activity: "최근영업활동내용", team: "팀",
      module: "모듈", am: "AM", acr_type: "ACR유형", culti_detail: "Culti 상세", ret_detail: "Ret.상세", term: "계약기간(월)",
      rev_ym: "매출발생년월", funnel_id: "Funnel번호", hq: "본부", annual: "연매출", contract_amt: "계약기간매출",
      prob: "수주(재계약)가능성", prev_monthly: "기존매출", new_monthly: "변경매출", updated_at: "최근영업활동내역 저장일시",
      confirmer: "확정자", confirmed_at: "확정일자", strategy_reg: "재계약전략 등록여부", bid_method: "입찰방식",
      qualification: "참가자격", winloss_reason: "승패사유", drop_reason: "Drop세부사유", churn_reason: "해지사유",
      churn_type: "해지유형", bid_no: "입찰공고번호", bid_name: "입찰공고명", expected_amt: "수주예상금액",
      possible_rev: "수주가능매출", rmr_excl: "RMR제외", midlarge_excl: "중대형퍼널제외",
    },
    PRODUCT_SLOTS: 5,
    REQUIRED_COLUMNS: ["고객사", "수주년월", "월매출합계", "현재상황", "팀", "AM", "ACR유형", "계약기간(월)", "매출발생년월",
      "Funnel번호", "본부", "계약기간매출", "기존매출", "변경매출"],
    ACR_TYPE_MAP: { "acq.": "A", acq: "A", a: "A", acqui: "A", "cul.": "C", cul: "C", c: "C", culti: "C", "ret.": "R", ret: "R", r: "R" },
    ACR_TYPE_LABEL: { A: "A (Acq.)", C: "C (Cul.)", R: "R (Ret.)" },
    KNOWN_STATUSES: ["Pre Sales", "제안완료", "Win", "재계약완료", "해지확정", "Drop", "Lose"],
    IN_PROGRESS: ["Pre Sales", "제안완료"],
    ACR_CONFIRMED_STATUS: { A: "Win", C: "Win", R: "재계약완료" },
    UNASSIGNED_ORG: "조직 미입력",
  };
  const isProg = (s) => s === "Pre Sales" || s === "제안완료";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const nn = (v) => v !== null && v !== undefined && !(typeof v === "number" && Number.isNaN(v));

  const ISSUE_LABELS = {
    FUNNEL_BLANK: "Funnel번호 없음(집계 제외)", FUNNEL_DUP: "Funnel번호 중복(검토 전 집계 제외)", TYPE_UNKNOWN: "알 수 없는 ACR유형",
    STATUS_UNKNOWN: "알 수 없는 현재상황", NUM_ERROR: "숫자 변환 실패", YM_ERROR_WIN: "수주년월 형식 오류", YM_ERROR_REV: "매출발생년월 형식 오류",
    YM_MISSING_WIN: "수주년월 누락", YM_MISSING_REV: "매출발생년월 누락", MONTHLY_MISSING: "월매출합계 누락", TERM_MISSING: "계약기간 누락",
    TERM_ZERO: "계약기간 0", TERM_NEG: "계약기간 음수", TERM_FRACTION: "계약기간 소수", TEAM_MISSING: "팀 미입력", AM_MISSING: "AM 미입력",
    PRODUCT_SUM_DIFF: "상품별 월매출 합계 ≠ 월매출합계", R_AMOUNT_MISMATCH: "R: 변경매출−기존매출 ≠ 월매출합계",
    DATE_ERROR_UPDATE: "최근 갱신일 형식 오류", OUT_OF_SCOPE_HQ: "대상 본부 외",
  };

  class LoadError extends Error {}

  // ================================================================ 값 파서 (data_loader.py 대응)
  function cleanStr(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" && Number.isNaN(v)) return null;
    if (v instanceof Date) v = isoDate(v);
    let s = String(v).replace(/\r/g, " ").replace(/\n/g, " ").trim();
    s = s.replace(/\s{2,}/g, " ");
    return s || null;
  }
  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  function parseNum(v) {
    if (v === null || v === undefined) return [null, false];
    if (typeof v === "boolean") return [null, true];
    if (typeof v === "number") return Number.isNaN(v) ? [null, false] : [v, false];
    const s = cleanStr(v);
    if (s === null) return [null, false];
    const s2 = s.replace(/,/g, "");
    return NUM_RE.test(s2) ? [Number(s2), false] : [null, true];
  }
  const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
  function validYm(y, m) { return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 ? y * 100 + m : null; }
  function serialToDate(n) { return new Date(EXCEL_EPOCH + n * 86400000); }
  function parseYm(v) {
    if (v === null || v === undefined) return [null, false];
    if (v instanceof Date) { const r = validYm(v.getFullYear(), v.getMonth() + 1); return [r, r === null]; }
    if (typeof v === "number") {
      if (Number.isNaN(v)) return [null, false];
      if (Number.isInteger(v)) {
        if (v >= 199001 && v <= 210012) { const r = validYm(Math.floor(v / 100), v % 100); return [r, r === null]; }
        if (v >= 20000 && v <= 80000) { const d = serialToDate(v); return [validYm(d.getUTCFullYear(), d.getUTCMonth() + 1), false]; }
      }
      return [null, true];
    }
    const s = cleanStr(v);
    if (s === null) return [null, false];
    let m = s.match(/^(\d{4})(\d{2})$/) || s.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*월?$/);
    if (!m) m = s.match(/^(\d{4})[-./](\d{1,2})[-./]\d{1,2}/);
    if (m) { const r = validYm(+m[1], +m[2]); return [r, r === null]; }
    return [null, true];
  }
  // 날짜는 UTC 자정 ms 로 보관
  function mkDate(y, m, d) {
    const t = Date.UTC(y, m - 1, d);
    const dd = new Date(t);
    return dd.getUTCFullYear() === y && dd.getUTCMonth() === m - 1 && dd.getUTCDate() === d ? t : null;
  }
  function parseDate(v) {
    if (v === null || v === undefined) return [null, false];
    if (v instanceof Date) return [mkDate(v.getFullYear(), v.getMonth() + 1, v.getDate()), false];
    if (typeof v === "number") {
      if (Number.isNaN(v)) return [null, false];
      const iv = Math.trunc(v);
      if (iv >= 19900101 && iv <= 21001231) { const t = mkDate(Math.floor(iv / 10000), Math.floor(iv / 100) % 100, iv % 100); return [t, t === null]; }
      if (iv >= 20000 && iv <= 80000) { const d = serialToDate(iv); return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), false]; }
      return [null, true];
    }
    const s = cleanStr(v);
    if (s === null) return [null, false];
    const m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/) || s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) { const t = mkDate(+m[1], +m[2], +m[3]); return [t, t === null]; }
    return [null, true];
  }
  function parseProb(v) {
    const s = cleanStr(v);
    if (s === null) return null;
    const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*%/);
    if (!m) return null;
    const p = Number(m[1]);
    return p >= 0 && p <= 100 ? p : null;
  }
  function isoDate(t) {
    if (t === null || t === undefined) return null;
    const d = t instanceof Date ? t : new Date(t);
    const z = (n) => String(n).padStart(2, "0");
    if (t instanceof Date) return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
    return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}`;
  }
  function rawDisplay(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return isoDate(v);
    if (typeof v === "number" && Number.isNaN(v)) return null;
    return v;
  }

  // ================================================================ 년월 유틸 (revenue.py 대응)
  function ymAdd(ym, k) { const y = Math.floor(ym / 100), m = ym % 100; const t = y * 12 + (m - 1) + k; return Math.floor(t / 12) * 100 + (((t % 12) + 12) % 12) + 1; }
  function ymRange(a, b) { const out = []; let c = a; while (c <= b) { out.push(c); c = ymAdd(c, 1); } return out; }
  function ymDiff(a, b) { return (Math.floor(b / 100) - Math.floor(a / 100)) * 12 + (b % 100 - a % 100); }
  function ymLabel(ym) { if (!nn(ym)) return ""; return `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, "0")}`; }

  // ================================================================ 엑셀 읽기
  function readWorkbook(buf) {
    if (typeof XLSX === "undefined") throw new LoadError("엑셀 읽기 라이브러리를 불러오지 못했습니다. 페이지를 새로 고치세요.");
    let wb;
    try { wb = XLSX.read(buf, { type: "array", cellDates: true }); }
    catch (e) { throw new LoadError("엑셀 파일을 열 수 없습니다(손상 또는 암호화 가능성)."); }
    const names = wb.SheetNames.slice();
    const order = names.includes(CFG.SHEET_NAME_PREFERRED) ? [CFG.SHEET_NAME_PREFERRED, ...names.filter((n) => n !== CFG.SHEET_NAME_PREFERRED)] : names;
    let best = null;
    for (const name of order) {
      const ws = wb.Sheets[name];
      if (!ws || !ws["!ref"]) continue;
      const rng = XLSX.utils.decode_range(ws["!ref"]);
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
      for (let i = 0; i < Math.min(10, aoa.length); i++) {
        const headers = (aoa[i] || []).map((h) => cleanStr(h) || "");
        const hit = CFG.REQUIRED_COLUMNS.filter((h) => headers.includes(h)).length;
        const headerRow = rng.s.r + i + 1;
        if (!best || hit > best.hit) best = { name, headerRow, headers, hit };
        if (hit === CFG.REQUIRED_COLUMNS.length) {
          const rows = [];
          for (let j = i + 1; j < aoa.length; j++) {
            const r = aoa[j] || [];
            if (r.every((v) => v === null || v === undefined || (typeof v === "string" && v.trim() === ""))) continue;
            rows.push({ excelRow: rng.s.r + j + 1, values: r });
          }
          return { sheet: name, headerRow, headers, rows };
        }
      }
    }
    if (!best) throw new LoadError("시트를 찾을 수 없습니다.");
    const missing = CFG.REQUIRED_COLUMNS.filter((h) => !best.headers.includes(h));
    throw new LoadError(`필수 열이 없습니다: ${missing.join(", ")} (시트 '${best.name}' ${best.headerRow}행 기준). 헤더 이름이 원본 Funnel 조회 양식과 같은지 확인하세요.`);
  }

  // ================================================================ 정규화
  function buildDataset(parsed, fileName, uploadedAt, extraMeta) {
    const t0 = Date.now();
    const { sheet, headerRow, headers } = parsed;
    const idx = {}; const dupHeaders = [];
    headers.forEach((h, i) => { if (!h) return; if (h in idx) { dupHeaders.push(h); return; } idx[h] = i; });
    const get = (row, name) => { const i = idx[name]; return i !== undefined && i < row.length ? (row[i] === undefined ? null : row[i]) : null; };
    const known = new Set(Object.values(CFG.COL));
    for (let k = 1; k <= CFG.PRODUCT_SLOTS; k++) ["Biz", "상품", "월매출"].forEach((p) => known.add(p + k));
    const missingOpt = Object.values(CFG.COL).filter((v) => !(v in idx)).sort();
    for (let k = 1; k <= CFG.PRODUCT_SLOTS; k++) ["Biz", "상품", "월매출"].forEach((p) => { if (!((p + k) in idx)) missingOpt.push(p + k); });
    const C = CFG.COL;
    const rawRows = []; const recs = [];
    for (const { excelRow, values: row } of parsed.rows) {
      const raw = { _row: excelRow };
      headers.forEach((h) => { if (h) raw[h] = rawDisplay(get(row, h)); });
      rawRows.push(raw);
      const issues = []; const numErr = [];
      const num = (name) => { const [v, e] = parseNum(get(row, name)); if (e) numErr.push(name); return v; };
      const fid = cleanStr(get(row, C.funnel_id));
      const team = cleanStr(get(row, C.team)); const am = cleanStr(get(row, C.am)); const hq = cleanStr(get(row, C.hq));
      const acrRaw = cleanStr(get(row, C.acr_type));
      const acr = acrRaw === null ? null : (CFG.ACR_TYPE_MAP[acrRaw.toLowerCase()] || null);
      const status = cleanStr(get(row, C.status));
      const [winYm, winErr] = parseYm(get(row, C.win_ym));
      const [revYm, revErr] = parseYm(get(row, C.rev_ym));
      const monthly = num(C.monthly);
      const termRaw = get(row, C.term);
      const [termV, termErr] = parseNum(termRaw);
      let term = null;
      if (termErr) { numErr.push(C.term); issues.push("TERM_MISSING"); }
      else if (termV === null) issues.push("TERM_MISSING");
      else if (termV === 0) issues.push("TERM_ZERO");
      else if (termV < 0) issues.push("TERM_NEG");
      else if (!Number.isInteger(termV)) issues.push("TERM_FRACTION");
      else term = termV;
      const [upd, updErr] = parseDate(get(row, C.updated_at));
      const products = []; let psum = 0; let hasP = false;
      for (let k = 1; k <= CFG.PRODUCT_SLOTS; k++) {
        const biz = cleanStr(get(row, "Biz" + k)); const prod = cleanStr(get(row, "상품" + k));
        const [amt, ae] = parseNum(get(row, "월매출" + k));
        if (ae) numErr.push("월매출" + k);
        if (biz === null && prod === null && amt === null) continue;
        products.push({ slot: k, biz, product: prod, amount: amt });
        if (amt !== null) { psum += amt; hasP = true; }
      }
      const r = {
        row: excelRow, funnel_id: fid, customer: cleanStr(get(row, C.customer)), hq,
        team: team || CFG.UNASSIGNED_ORG, am: am || CFG.UNASSIGNED_ORG, module: cleanStr(get(row, C.module)),
        acr_raw: acrRaw, acr_type: acr, culti_detail: cleanStr(get(row, C.culti_detail)), ret_detail: cleanStr(get(row, C.ret_detail)),
        status, win_ym: winYm, rev_ym: revYm, term, term_raw: rawDisplay(termRaw), monthly,
        contract_amt: num(C.contract_amt), annual: num(C.annual), prev_monthly: num(C.prev_monthly), new_monthly: num(C.new_monthly),
        possible_rev: num(C.possible_rev), prob_raw: cleanStr(get(row, C.prob)), prob: parseProb(get(row, C.prob)), updated_at: upd,
        confirmer: cleanStr(get(row, C.confirmer)), strategy_reg: cleanStr(get(row, C.strategy_reg)),
        bid_method: cleanStr(get(row, C.bid_method)), qualification: cleanStr(get(row, C.qualification)),
        winloss_reason: cleanStr(get(row, C.winloss_reason)), drop_reason: cleanStr(get(row, C.drop_reason)),
        churn_reason: cleanStr(get(row, C.churn_reason)), churn_type: cleanStr(get(row, C.churn_type)),
        bid_no: cleanStr(get(row, C.bid_no)), bid_name: cleanStr(get(row, C.bid_name)), expected_amt: cleanStr(get(row, C.expected_amt)),
        rmr_excl: cleanStr(get(row, C.rmr_excl)), midlarge_excl: cleanStr(get(row, C.midlarge_excl)),
        products, product_names: Array.from(new Set(products.map((p) => p.product).filter(Boolean))).sort(),
        product_sum: hasP ? psum : null, num_error_cols: Array.from(new Set(numErr)).sort(),
      };
      r.am_key = `${r.team}|${r.am}`;
      if (fid === null) issues.push("FUNNEL_BLANK");
      if (acr === null) issues.push("TYPE_UNKNOWN");
      if (!CFG.KNOWN_STATUSES.includes(status)) issues.push("STATUS_UNKNOWN");
      if (numErr.length) issues.push("NUM_ERROR");
      if (winErr) issues.push("YM_ERROR_WIN"); else if (winYm === null) issues.push("YM_MISSING_WIN");
      if (revErr) issues.push("YM_ERROR_REV"); else if (revYm === null) issues.push("YM_MISSING_REV");
      if (monthly === null && !numErr.includes(C.monthly)) issues.push("MONTHLY_MISSING");
      if (team === null) issues.push("TEAM_MISSING");
      if (am === null) issues.push("AM_MISSING");
      if (updErr) issues.push("DATE_ERROR_UPDATE");
      if (hasP && monthly !== null && Math.abs(psum - monthly) > 1e-6) issues.push("PRODUCT_SUM_DIFF");
      if (acr === "R" && monthly !== null && r.prev_monthly !== null && r.new_monthly !== null &&
        Math.abs((r.new_monthly - r.prev_monthly) - monthly) > 1e-6) issues.push("R_AMOUNT_MISMATCH");
      if (hq !== CFG.TARGET_HQ) issues.push("OUT_OF_SCOPE_HQ");
      r.issues = issues;
      recs.push(r);
    }
    if (!recs.length) throw new LoadError("데이터 행이 없습니다.");
    const cnt = {};
    recs.forEach((r) => { if (r.funnel_id !== null) cnt[r.funnel_id] = (cnt[r.funnel_id] || 0) + 1; });
    recs.forEach((r) => {
      r.dup_group = r.funnel_id !== null && cnt[r.funnel_id] > 1 ? r.funnel_id : null;
      if (r.dup_group) r.issues.push("FUNNEL_DUP");
      r.agg_excluded = r.issues.includes("FUNNEL_DUP") || r.issues.includes("FUNNEL_BLANK");
      r.in_scope = r.hq === CFG.TARGET_HQ;
    });
    const quality = buildQuality(recs, dupHeaders);
    const meta = Object.assign({
      file_name: fileName, uploaded_at: uploadedAt, sheet, header_row: headerRow, row_count: recs.length,
      column_count: headers.filter(Boolean).length, missing_optional_columns: missingOpt,
      unknown_columns: headers.filter((h) => h && !known.has(h)).sort(), duplicate_headers: dupHeaders,
      load_seconds: (Date.now() - t0) / 1000, target_hq: CFG.TARGET_HQ,
    }, extraMeta || {});
    const byRow = {}; rawRows.forEach((r) => { byRow[r._row] = r; });
    const byIdx = {}; recs.forEach((r) => { byIdx[r.row] = r; });
    return { df: recs, rawRows, byRow, byIdx, headers: headers.filter(Boolean), meta, quality, empty: false };
  }
  function buildQuality(df, dupHeaders) {
    const counts = {};
    df.forEach((r) => new Set(r.issues).forEach((c) => { counts[c] = (counts[c] || 0) + 1; }));
    const groups = {};
    df.forEach((r) => { if (r.dup_group) (groups[r.dup_group] = groups[r.dup_group] || []).push(r.row); });
    return {
      source_rows: df.length, in_scope_rows: df.filter((r) => r.in_scope).length,
      agg_excluded_rows: df.filter((r) => r.agg_excluded).length,
      dup_group_count: Object.keys(groups).length,
      dup_groups: Object.keys(groups).sort().map((k) => ({ funnel_id: k, rows: groups[k], count: groups[k].length })),
      issue_counts: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ code: k, label: ISSUE_LABELS[k] || k, rows: v })),
      rows_with_issues: df.filter((r) => r.issues.length > 0).length,
      unknown_types: Array.from(new Set(df.filter((r) => r.acr_type === null && r.acr_raw !== null).map((r) => r.acr_raw))).sort(),
      unknown_statuses: Array.from(new Set(df.filter((r) => r.status !== null && !CFG.KNOWN_STATUSES.includes(r.status)).map((r) => r.status))).sort(),
      duplicate_headers: dupHeaders,
    };
  }
  function emptyDataset(reason) {
    return { df: [], rawRows: [], byRow: {}, byIdx: {}, headers: [], meta: { file_name: null, reason: reason || "적용된 원본 데이터가 없습니다." }, quality: {}, empty: true };
  }

  // ================================================================ ACR (revenue.py 대응)
  const MODES = { start: "매출개시월 기준 ACR 월매출 증감액", term: "계약기간 반영 월별 매출 증감 추정" };
  const SERIES = ["A", "C", "R", "AC", "ACR"];
  const EXCL = {
    NOT_CONFIRMED: "확정 ACR 조건 아님", AGG: "Funnel번호 중복·누락(검토 전 제외)", REV_YM: "매출발생년월 누락·오류",
    MONTHLY: "월매출합계 누락·숫자 오류", TERM: "계약기간 누락·0·음수·소수", PRODUCT_AMT: "선택 상품 월매출 누락",
  };
  function productAmount(products, sel) {
    const hit = products.filter((p) => sel.has(p.product));
    if (!hit.length) return [null, false];
    const vals = hit.map((p) => p.amount).filter((a) => a !== null);
    if (!vals.length) return [null, true];
    return [vals.reduce((a, b) => a + b, 0), true];
  }
  const isConfirmed = (r) => r.acr_type in CFG.ACR_CONFIRMED_STATUS && r.status === CFG.ACR_CONFIRMED_STATUS[r.acr_type];
  function acrBasis(df, mode, products) {
    const sel = new Set(products || []);
    const out = new Map();
    df.forEach((r) => {
      let amount, hasProd;
      if (sel.size) [amount, hasProd] = productAmount(r.products, sel); else { amount = r.monthly; hasProd = true; }
      const conf = isConfirmed(r);
      let reason = null;
      if (!conf) reason = EXCL.NOT_CONFIRMED;
      else if (r.agg_excluded) reason = EXCL.AGG;
      else if (r.rev_ym === null) reason = EXCL.REV_YM;
      else if (sel.size ? (hasProd && amount === null) : amount === null) reason = sel.size ? EXCL.PRODUCT_AMT : EXCL.MONTHLY;
      else if (mode === "term" && r.term === null) reason = EXCL.TERM;
      out.set(r.row, { amount, has_product: hasProd, confirmed: conf, excl_reason: reason, included: reason === null && hasProd });
    });
    return out;
  }
  function contributions(df, mode, from, to, products) {
    const basis = acrBasis(df, mode, products);
    const con = [];
    df.forEach((r) => {
      const b = basis.get(r.row);
      if (!b.included) return;
      const base = { row: r.row, funnel_id: r.funnel_id, team: r.team, am_key: r.am_key, am: r.am, acr_type: r.acr_type, amount: b.amount };
      if (mode === "term") {
        const end = ymAdd(r.rev_ym, r.term - 1);
        const lo = Math.max(r.rev_ym, from), hi = Math.min(end, to);
        if (lo <= hi) ymRange(lo, hi).forEach((ym) => con.push(Object.assign({ ym }, base)));
      } else if (r.rev_ym >= from && r.rev_ym <= to) con.push(Object.assign({ ym: r.rev_ym }, base));
    });
    return [con, basis];
  }
  function typeSums(g) {
    let a = 0, c = 0, r = 0;
    g.forEach((x) => { if (x.acr_type === "A") a += x.amount; else if (x.acr_type === "C") c += x.amount; else if (x.acr_type === "R") r += x.amount; });
    return { A: a, C: c, R: r, AC: a + c, ACR: a + c + r };
  }
  const uniq = (arr) => new Set(arr).size;
  function groupBy(arr, keyFn) {
    const m = new Map();
    arr.forEach((x) => { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
    return new Map(Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  }
  function computeAcr(df, mode, from, to, products, types) {
    mode = MODES[mode] ? mode : "start";
    types = (types || ["A", "C", "R"]).filter((t) => ["A", "C", "R"].includes(t));
    if (!types.length) types = ["A", "C", "R"];
    let [con, basis] = contributions(df, mode, from, to, products);
    con = con.filter((x) => types.includes(x.acr_type));
    const cum = { A: 0, C: 0, R: 0, AC: 0, ACR: 0 };
    const byYm = groupBy(con, (x) => x.ym);
    const monthly = ymRange(from, to).map((ym) => {
      const g = byYm.get(ym) || [];
      const s = typeSums(g);
      SERIES.forEach((k) => { cum[k] += s[k]; });
      return Object.assign({ ym, label: ymLabel(ym) }, s, { funnels: uniq(g.map((x) => x.row)), cum: Object.assign({}, cum) });
    });
    const totals = Object.assign(typeSums(con), { funnels: uniq(con.map((x) => x.row)) });
    ["A", "C", "R"].forEach((t) => { totals["funnels_" + t] = uniq(con.filter((x) => x.acr_type === t).map((x) => x.row)); });
    const org = (key, labels) => {
      const rows = [];
      groupBy(con, (x) => x[key]).forEach((g, k) => {
        const rneg = g.filter((x) => x.acr_type === "R" && x.amount < 0);
        const rec = { key: k };
        labels.forEach((l) => { rec[l] = g[0][l]; });
        rows.push(Object.assign(rec, typeSums(g), { funnels: uniq(g.map((x) => x.row)), r_neg_count: uniq(rneg.map((x) => x.row)), r_neg_amount: rneg.reduce((a, x) => a + x.amount, 0) }));
      });
      return rows.sort((a, b) => b.ACR - a.ACR);
    };
    const excluded = {}; let confirmedRows = 0;
    basis.forEach((b) => { if (!b.confirmed) return; confirmedRows++; if (b.excl_reason) excluded[b.excl_reason] = (excluded[b.excl_reason] || 0) + 1; });
    return {
      mode, mode_label: MODES[mode], range: [from, to], types, monthly, totals,
      by_team: org("team", ["team"]), by_am: org("am_key", ["team", "am"]), excluded,
      included_rows: Array.from(new Set(con.map((x) => x.row))).sort((a, b) => a - b), confirmed_rows: confirmedRows,
    };
  }

  // ================================================================ 파라미터 (analytics.py 대응)
  function todayIso() { return isoDate(new Date()); }
  function ymFromStr(v) {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v).replace(/-/g, "");
    if (/^\d{6}$/.test(s)) { const y = +s.slice(0, 4), m = +s.slice(4); if (y >= 1990 && y <= 2100 && m >= 1 && m <= 12) return y * 100 + m; }
    return null;
  }
  const listOf = (v) => (v === null || v === undefined ? [] : typeof v === "string" ? v.split(",").filter(Boolean) : v.filter((x) => x !== null && x !== "").map(String));
  function parseParams(d) {
    d = d || {};
    let base = /^\d{4}-\d{2}-\d{2}$/.test(String(d.base_date || "")) ? String(d.base_date) : todayIso();
    const [by, bm, bd] = base.split("-").map(Number);
    if (mkDate(by, bm, bd) === null) base = todayIso();
    const y = +base.slice(0, 4);
    let from = ymFromStr(d.ym_from) || y * 100 + 1;
    let to = ymFromStr(d.ym_to) || y * 100 + 12;
    if (from > to) [from, to] = [to, from];
    if (ymDiff(from, to) > 120) to = ymAdd(from, 120);
    const th = Object.assign({}, CFG.BUSINESS_DEFAULTS);
    Object.entries(d.th || {}).forEach(([k, v]) => {
      if (!(k in th)) return;
      const f = Number(v);
      if (v !== null && v !== "" && Number.isFinite(f) && f >= 0) th[k] = k === "stale_days" || k === "imminent_months" ? Math.trunc(f) : f;
    });
    let types = listOf(d.types).filter((t) => ["A", "C", "R"].includes(t));
    if (!types.length) types = ["A", "C", "R"];
    const [yy, mm] = base.split("-").map(Number);
    return {
      base_date: base, base_ms: Date.UTC(yy, mm - 1, +base.slice(8)), base_ym: yy * 100 + mm,
      ym_from: from, ym_to: to, level: ["all", "team", "am"].includes(d.level) ? d.level : "all",
      teams: listOf(d.teams), ams: listOf(d.ams), types, products: listOf(d.products),
      search: String(d.search || "").trim().slice(0, 100), mode: MODES[d.mode] ? d.mode : "start",
      excl_midlarge: !!d.excl_midlarge, excl_rmr: !!d.excl_rmr, confirmed_only: !!d.confirmed_only, th,
    };
  }
  function paramsSummary(p) {
    return {
      "기준일": p.base_date, "조회기간": `${ymLabel(p.ym_from)} ~ ${ymLabel(p.ym_to)}`,
      "집계 수준": { all: "담당 전체", team: "팀", am: "AM" }[p.level], "팀": p.teams.join(", ") || "전체",
      "AM": p.ams.map((a) => `${a.split("|").pop()}(${a.split("|")[0]})`).join(", ") || "전체",
      "ACR유형": p.types.join(", "), "상품": p.products.join(", ") || "전체(월매출합계 사용)", "검색": p.search || "없음",
      "ACR 기준": MODES[p.mode],
      "보조필터": [["중대형퍼널제외=Y 제외", p.excl_midlarge], ["RMR제외=Y 제외", p.excl_rmr], ["확정자 입력 건만", p.confirmed_only]].filter((x) => x[1]).map((x) => x[0]).join(", ") || "미적용",
      "업무 기준": p.th,
    };
  }

  // ================================================================ 공통 필터
  function filterDf(ds, p, includeExcluded) {
    if (ds.empty) return [];
    const sel = new Set(p.products); const q = p.search.toLowerCase();
    const allTypes = p.types.length === 3;
    return ds.df.filter((r) => {
      if (!r.in_scope) return false;
      if (!includeExcluded && r.agg_excluded) return false;
      if (p.teams.length && !p.teams.includes(r.team)) return false;
      if (p.ams.length && !p.ams.includes(r.am_key)) return false;
      if (!allTypes && !p.types.includes(r.acr_type)) return false;
      if (sel.size && !r.product_names.some((n) => sel.has(n))) return false;
      if (q && !((r.customer || "").toLowerCase().includes(q) || (r.funnel_id || "").toLowerCase().includes(q))) return false;
      if (p.excl_midlarge && r.midlarge_excl === "Y") return false;
      if (p.excl_rmr && r.rmr_excl === "Y") return false;
      if (p.confirmed_only && r.confirmer === null) return false;
      return true;
    });
  }
  const inPeriod = (v, p) => nn(v) && v >= p.ym_from && v <= p.ym_to;
  function fsum(arr) { const v = arr.filter(nn); return v.length ? v.reduce((a, b) => a + b, 0) : null; }
  function amountSplit(arr) {
    const v = arr.filter(nn);
    return {
      total: fsum(arr), positive: v.filter((x) => x > 0).reduce((a, b) => a + b, 0), negative: v.filter((x) => x < 0).reduce((a, b) => a + b, 0),
      pos_count: v.filter((x) => x > 0).length, zero_count: v.filter((x) => x === 0).length, neg_count: v.filter((x) => x < 0).length,
      missing_count: arr.length - v.length,
    };
  }
  const BUCKETS = ["이번 달", "다음 달", "이후", "예정월 경과", "예정월 미입력"];
  function bucketOf(win, p) {
    if (!nn(win)) return "예정월 미입력";
    if (win < p.base_ym) return "예정월 경과";
    if (win === p.base_ym) return "이번 달";
    if (win === ymAdd(p.base_ym, 1)) return "다음 달";
    return "이후";
  }
  function updState(r, p) {
    const missing = r.updated_at === null;
    const days = missing ? null : Math.round((p.base_ms - r.updated_at) / 86400000);
    return { days, missing, future: !missing && r.updated_at > p.base_ms, stale: !missing && days > p.th.stale_days };
  }

  // ================================================================ 우선 확인 규칙
  const RULES = [
    ["OVERDUE", 1, "예정월 경과", "수주(재계약) 일정·현재 단계 확인", "진행 중(Pre Sales·제안완료) & 수주년월 < 기준월"],
    ["WIN_NO_REV", 1, "Win·매출발생년월 누락", "개통·매출 개시 일정 확인", "Win & 매출발생년월 없음"],
    ["RENEWAL_DECREASE", 1, "재계약 감액 예상", "감액 사유·방어 방안 확인", "R 진행 중 & (변경매출 < 기존매출 또는 월매출합계 < 0)"],
    ["LARGE_STALE", 1, "대형 사업·장기 미갱신", "진행상황·다음 활동 갱신", "진행 중 & 대형(A/C 계약기간매출 ≥ 기준, R 기존 월매출 ≥ 기준) & (미갱신 또는 갱신일 미입력)"],
    ["PROPOSAL_IMMINENT", 2, "제안완료·예정월 임박", "평가·계약 일정 확인", "제안완료 & 기준월 ≤ 수주년월 ≤ 기준월+임박개월"],
    ["HIGH_PROB_PRESALES", 2, "높은 입력 가능성·Pre Sales", "단계 갱신 또는 가능성 재확인", "Pre Sales & 수주(재계약)가능성 ≥ 기준%"],
    ["LARGE_RENEWAL", 2, "기존 월매출 큰 진행 중 재계약", "재계약 대응계획 확인", "R 진행 중 & 기존매출 ≥ 대형 재계약 기준"],
    ["STALE", 2, "장기 미갱신", "진행상황·다음 활동 갱신", "진행 중 & 기준일 − 최근영업활동내역 저장일시 > 미갱신 기준일수"],
    ["UPDATE_MISSING", 2, "갱신일 미입력", "최근 활동 내역 등록", "진행 중 & 저장일시 없음"],
    ["STRATEGY_MISSING", 3, "재계약전략 미등록", "대응계획 확인·전략 등록", "R 진행 중 & 재계약전략 등록여부 ≠ Y(N 또는 미입력)"],
    ["REV_BEFORE_WIN", 3, "매출발생년월이 수주년월보다 이전", "일정 입력 기준 확인", "Drop·Lose 제외 & 매출발생년월 < 수주년월 (자동 오류 확정 아님)"],
    ["WIN_FUTURE_REV", 3, "Win·매출개시 미래", "개통·매출 개시 예정 확인", "Win & 매출발생년월 > 기준월"],
    ["UPDATE_FUTURE", 3, "갱신일이 기준일 이후", "갱신일·기준일 확인", "저장일시 > 기준일"],
    ["AMOUNT_MISMATCH", 3, "금액 불일치", "원본 입력 기준 확인", "상품별 월매출 합계 ≠ 월매출합계 또는 R의 변경−기존 ≠ 월매출합계"],
  ];
  const RULE_MAP = {}; RULES.forEach((r) => { RULE_MAP[r[0]] = r; });
  const gte = (v, t) => nn(v) && v >= t;
  const lt = (a, b) => nn(a) && nn(b) && a < b;
  function checkOf(r, p) {
    const prog = isProg(r.status), isR = r.acr_type === "R", th = p.th, base = p.base_ym;
    const immHi = ymAdd(base, th.imminent_months);
    const u = updState(r, p);
    const large = (!isR && gte(r.contract_amt, th.large_contract_amount)) || (isR && gte(r.prev_monthly, th.large_renewal_monthly));
    const decrease = isR && prog && (lt(r.new_monthly, r.prev_monthly) || lt(r.monthly, 0));
    const cond = {
      OVERDUE: prog && lt(r.win_ym, base),
      WIN_NO_REV: r.status === "Win" && r.rev_ym === null,
      RENEWAL_DECREASE: decrease,
      LARGE_STALE: prog && large && (u.stale || u.missing),
      PROPOSAL_IMMINENT: r.status === "제안완료" && nn(r.win_ym) && r.win_ym >= base && r.win_ym <= immHi,
      HIGH_PROB_PRESALES: r.status === "Pre Sales" && gte(r.prob, th.high_probability),
      LARGE_RENEWAL: isR && prog && gte(r.prev_monthly, th.large_renewal_monthly),
      STALE: prog && u.stale,
      UPDATE_MISSING: prog && u.missing,
      STRATEGY_MISSING: isR && prog && r.strategy_reg !== "Y",
      REV_BEFORE_WIN: r.status !== "Drop" && r.status !== "Lose" && lt(r.rev_ym, r.win_ym),
      WIN_FUTURE_REV: r.status === "Win" && nn(r.rev_ym) && r.rev_ym > base,
      UPDATE_FUTURE: u.future,
      AMOUNT_MISMATCH: r.issues.includes("PRODUCT_SUM_DIFF") || r.issues.includes("R_AMOUNT_MISMATCH"),
    };
    const codes = RULES.map((x) => x[0]).filter((c) => cond[c]);
    const level = codes.length ? Math.min(...codes.map((c) => RULE_MAP[c][1])) : null;
    let amount, basis;
    if (prog && !isR) { amount = r.contract_amt; basis = "계약기간매출"; }
    else if (prog && isR) { amount = r.prev_monthly; basis = "기존 월매출"; }
    else { amount = r.monthly; basis = "월매출합계(증감)"; }
    return { codes, level, amount, amount_basis: basis };
  }
  function computeChecks(df, p) { const m = new Map(); df.forEach((r) => m.set(r.row, checkOf(r, p))); return m; }

  // ================================================================ 행 직렬화
  function fmtG(x) { return String(Number(x.toPrecision(6))); }
  function productsText(ps) { return ps.map((x) => `${x.product || "(상품 미입력)"}${x.amount === null ? "" : " " + fmtG(x.amount)}`).join("; "); }
  function rowRecord(r, ck, acr) {
    const codes = (ck && ck.codes) || [];
    return {
      row: r.row, funnel_id: r.funnel_id, customer: r.customer, team: r.team, am: r.am, am_key: r.am_key,
      acr_type: r.acr_type || r.acr_raw, status: r.status, win_ym: ymLabel(r.win_ym), rev_ym: ymLabel(r.rev_ym),
      term: r.term !== null ? r.term : r.term_raw, monthly: r.monthly, contract_amt: r.contract_amt, prev_monthly: r.prev_monthly,
      new_monthly: r.new_monthly, prob: r.prob_raw, products: productsText(r.products), updated_at: r.updated_at === null ? null : isoDate(r.updated_at),
      strategy_reg: r.strategy_reg, bid_no: r.bid_no, bid_name: r.bid_name, bid_method: r.bid_method,
      acr_included: acr ? acr.included : null, acr_excl_reason: acr ? acr.reason : null, agg_excluded: r.agg_excluded,
      issues: r.issues.filter((i) => i !== "OUT_OF_SCOPE_HQ").map((i) => ISSUE_LABELS[i] || i),
      check_codes: codes, checks: codes.map((c) => RULE_MAP[c][2]), actions: Array.from(new Set(codes.map((c) => RULE_MAP[c][3]))),
      level: ck ? ck.level : null, check_amount: ck ? ck.amount : null, check_amount_basis: ck ? ck.amount_basis : null,
    };
  }
  function sortBy(arr, keys) { // keys: [[fn, asc]] — null 은 항상 뒤, 안정 정렬
    return arr.map((x, i) => [x, i]).sort((A, B) => {
      for (const [fn, asc] of keys) {
        const a = fn(A[0]), b = fn(B[0]);
        const an = !nn(a), bn = !nn(b);
        if (an && bn) continue; if (an) return 1; if (bn) return -1;
        if (a < b) return asc ? -1 : 1; if (a > b) return asc ? 1 : -1;
      }
      return A[1] - B[1];
    }).map((x) => x[0]);
  }

  // ================================================================ 화면: ACR
  function acrView(ds, p) {
    const df = filterDf(ds, p);
    if (!df.length) return { empty: true };
    const res = computeAcr(df, p.mode, p.ym_from, p.ym_to, p.products, p.types);
    res.basis = {
      "기간 기준": p.mode === "start" ? "매출발생년월" : "매출발생년월부터 계약기간(월) 동안 매월 반영(시작월 포함)",
      "확정 조건": "A=Acq.+Win, C=Cul.+Win, R=Ret.+재계약완료",
      "금액": p.products.length ? "선택 상품의 대응 월매출(상품1~5)" : "월매출합계",
      "R 해석": "월매출합계 = 재계약 증감액(음수 유지). 재계약 후 월매출(변경매출)은 합산하지 않음",
      "누적": `선택기간 시작월(${ymLabel(p.ym_from)})부터 누적`,
      "Funnel 건수": "월별 반복 반영 횟수가 아닌 고유 Funnel 수",
      "주의": p.mode === "term" ? "계약기간 반영값은 현재 입력 상태·일정 기반 추정이며 청구·회계 실적이 아님" : "해당 월에 시작되는 월매출 증감 규모이며 반복 청구 매출·회계 실적이 아님",
    };
    return res;
  }

  // ================================================================ 우선 확인 목록
  function priorityRows(df, p, ck, limit, codes) {
    ck = ck || computeChecks(df, p);
    let rows = df.filter((r) => ck.get(r.row).codes.length > 0);
    if (codes && codes.length) rows = rows.filter((r) => ck.get(r.row).codes.some((c) => codes.includes(c)));
    rows = sortBy(rows, [[(r) => ck.get(r.row).level, true], [(r) => -ck.get(r.row).codes.length, true],
      [(r) => { const a = ck.get(r.row).amount; return nn(a) ? -Math.abs(a) : 1; }, true]]);
    if (limit) rows = rows.slice(0, limit);
    return rows.map((r, i) => Object.assign(rowRecord(r, ck.get(r.row)), { rank: i + 1 }));
  }
  function rulesTable(p) {
    const th = p.th;
    return RULES.map(([c, lv, lb, ac, cd]) => ({ code: c, level: lv, label: lb, action: ac, condition: cd })).concat([{
      code: "_TH", level: null, label: "적용 기준값", action: "",
      condition: `미갱신 ${th.stale_days}일 초과 / 대형 A·C 계약기간매출 ≥ ${fmtG(th.large_contract_amount)} / 대형 R 기존 월매출 ≥ ${fmtG(th.large_renewal_monthly)} / 임박 기준월+${th.imminent_months}개월 / 높은 가능성 ≥ ${fmtG(th.high_probability)}% (금액은 원본 단위 백만원)`,
    }]);
  }

  // ================================================================ 화면: 종합 현황
  function overviewView(ds, p) {
    const df = filterDf(ds, p);
    if (!df.length) return { empty: true };
    const acr = computeAcr(df, p.mode, p.ym_from, p.ym_to, p.products, ["A", "C", "R"]);
    const prog = df.filter((r) => isProg(r.status));
    const progAc = prog.filter((r) => r.acr_type === "A" || r.acr_type === "C");
    const progR = prog.filter((r) => r.acr_type === "R");
    const churn = df.filter((r) => r.status === "해지확정" && inPeriod(r.win_ym, p));
    const ck = computeChecks(df, p);
    const withCk = df.filter((r) => ck.get(r.row).codes.length);
    const rowsOf = (sub, limit) => sub.slice(0, limit).map((r) => rowRecord(r, ck.get(r.row)));
    const upcoming = sortBy(prog.filter((r) => ["이번 달", "다음 달"].includes(bucketOf(r.win_ym, p))), [[(r) => r.win_ym, true], [(r) => r.contract_amt, false]]);
    const overdue = sortBy(prog.filter((r) => bucketOf(r.win_ym, p) === "예정월 경과"), [[(r) => r.win_ym, true]]);
    const rDec = progR.filter((r) => lt(r.new_monthly, r.prev_monthly) || lt(r.monthly, 0));
    const key = p.level === "am" ? "am_key" : "team";
    const teamChecks = [];
    groupBy(withCk, (r) => r[key]).forEach((g, k) => {
      const by = {};
      g.forEach((r) => ck.get(r.row).codes.forEach((c) => { by[c] = (by[c] || 0) + 1; }));
      teamChecks.push({ key: k, team: g[0].team, am: key === "am_key" ? g[0].am : null, funnels: g.length, level1: g.filter((r) => ck.get(r.row).level === 1).length, by_code: by });
    });
    teamChecks.sort((a, b) => b.level1 - a.level1 || b.funnels - a.funnels);
    return {
      kpi: {
        acr: acr.totals, acr_mode_label: MODES[p.mode], prog_ac_count: progAc.length, prog_ac_amount: amountSplit(progAc.map((r) => r.contract_amt)),
        prog_r_count: progR.length, prog_r_prev: fsum(progR.map((r) => r.prev_monthly)), churn_count: churn.length,
        check_count: withCk.length, check_level1: withCk.filter((r) => ck.get(r.row).level === 1).length,
      },
      acr_monthly: acr.monthly, acr_excluded: acr.excluded,
      upcoming: rowsOf(upcoming, 20), upcoming_count: upcoming.length, overdue: rowsOf(overdue, 20), overdue_count: overdue.length,
      renewal_decrease: rowsOf(rDec, 10), renewal_decrease_count: rDec.length,
      churn: rowsOf(sortBy(churn, [[(r) => r.prev_monthly, false]]), 10),
      team_checks: teamChecks, priority: priorityRows(df, p, ck, 20),
      basis: {
        "ACR": `${MODES[p.mode]} · 매출발생년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)}`,
        "진행 중": "현재상황 Pre Sales·제안완료 전체(기간 필터 미적용, 현재 상태 기준)",
        "진행 중 금액": "A/C 계약기간매출 / R 기존 월매출(원본값, 다른 열로 대체 안 함)",
        "해지확정": `수주년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)} (해지월 아님)`,
        "수주 예정": `수주년월을 수주 예정월로 사용(업무 가정), 기준월 ${ymLabel(p.base_ym)}`,
        "확인 필요": "우선 확인 규칙 1개 이상 해당 고유 Funnel(기간 무관)",
      },
    };
  }

  // ================================================================ 화면: 수주·Funnel
  const PROB_BINS = [["0%", 0, 0], ["1~29%", 1, 29.999], ["30~49%", 30, 49.999], ["50~69%", 50, 69.999], ["70~89%", 70, 89.999], ["90~100%", 90, 100]];
  function probBin(v) { if (!nn(v)) return "미확인"; for (const [lb, lo, hi] of PROB_BINS) if (v >= lo && v <= hi) return lb; return "미확인"; }
  function reasonTable(vals) {
    const total = vals.length, missing = vals.filter((v) => v === null).length;
    const c = new Map();
    vals.forEach((v) => { const k = v === null ? "(미입력)" : v; c.set(k, (c.get(k) || 0) + 1); });
    const items = Array.from(c.entries()).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
    return { total, missing, missing_ratio: total ? missing / total : null, items };
  }
  function funnelView(ds, p) {
    const df = filterDf(ds, p);
    if (!df.length) return { empty: true };
    const ac = df.filter((r) => r.acr_type === "A" || r.acr_type === "C");
    const rr = df.filter((r) => r.acr_type === "R");
    const acp = ac.filter((r) => inPeriod(r.win_ym, p));
    const stage = ["Pre Sales", "제안완료", "Win", "Lose", "Drop"].map((s) => { const g = acp.filter((r) => r.status === s); return { status: s, count: g.length, amount: fsum(g.map((r) => r.contract_amt)) }; });
    const rp = rr.filter((r) => inPeriod(r.win_ym, p));
    const stageR = ["Pre Sales", "제안완료", "재계약완료", "해지확정"].map((s) => { const g = rp.filter((r) => r.status === s); return { status: s, count: g.length, prev: fsum(g.map((r) => r.prev_monthly)), new: fsum(g.map((r) => r.new_monthly)), monthly: fsum(g.map((r) => r.monthly)) }; });
    const progAc = ac.filter((r) => isProg(r.status));
    const sched = BUCKETS.map((k) => { const g = progAc.filter((r) => bucketOf(r.win_ym, p) === k); return { bucket: k, count: g.length, amount: amountSplit(g.map((r) => r.contract_amt)) }; });
    const ck = computeChecks(ac, p);
    const fcodes = ["OVERDUE", "PROPOSAL_IMMINENT", "HIGH_PROB_PRESALES", "LARGE_STALE", "REV_BEFORE_WIN", "WIN_NO_REV", "WIN_FUTURE_REV"];
    const codeCounts = fcodes.map((c) => ({ code: c, label: RULE_MAP[c][2], action: RULE_MAP[c][3], count: ac.filter((r) => ck.get(r.row).codes.includes(c)).length }));
    const bins = PROB_BINS.map((x) => x[0]).concat(["미확인"]).map((lb) => {
      const g = progAc.filter((r) => probBin(r.prob) === lb);
      const valid = g.filter((r) => nn(r.contract_amt) && nn(r.prob));
      return { bin: lb, count: g.length, amount: amountSplit(g.map((r) => r.contract_amt)),
        weighted: valid.length ? valid.reduce((a, r) => a + r.contract_amt * r.prob / 100, 0) : (lb === "미확인" ? null : 0) };
    });
    const vw = progAc.filter((r) => nn(r.contract_amt) && nn(r.prob));
    const weightedTotal = {
      positive: vw.filter((r) => r.contract_amt > 0).reduce((a, r) => a + r.contract_amt * r.prob / 100, 0),
      negative: vw.filter((r) => r.contract_amt < 0).reduce((a, r) => a + r.contract_amt * r.prob / 100, 0),
      included: vw.length, excluded: progAc.length - vw.length,
    };
    const closed = acp.filter((r) => ["Win", "Lose", "Drop"].includes(r.status));
    const st = (g, s) => g.filter((r) => r.status === s);
    const w = st(closed, "Win").length, lo = st(closed, "Lose").length, dr = st(closed, "Drop").length;
    const outcome = {
      win: w, lose: lo, drop: dr,
      win_amount: fsum(st(closed, "Win").map((r) => r.contract_amt)), lose_amount: fsum(st(closed, "Lose").map((r) => r.contract_amt)),
      drop_amount: fsum(st(closed, "Drop").map((r) => r.contract_amt)), win_rate: w + lo > 0 ? w / (w + lo) : null,
      by_type: ["A", "C"].map((t) => { const g = closed.filter((r) => r.acr_type === t); const tw = st(g, "Win").length, tl = st(g, "Lose").length; return { type: t, win: tw, lose: tl, drop: st(g, "Drop").length, win_rate: tw + tl ? tw / (tw + tl) : null }; }),
    };
    return {
      stage, stage_r: stageR, schedule: sched, check_counts: codeCounts, checks: priorityRows(ac, p, ck, 50, fcodes),
      prob_bins: bins, weighted_total: weightedTotal, outcome,
      reasons: { win: reasonTable(st(closed, "Win").map((r) => r.winloss_reason)), lose: reasonTable(st(closed, "Lose").map((r) => r.winloss_reason)), drop: reasonTable(st(closed, "Drop").map((r) => r.drop_reason)) },
      basis: {
        "단계 분포": `A/C, 수주년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)}의 현재 상태 분포(과거 단계 이력·전환율 아님)`,
        "금액": "진행 중 Funnel의 계약금액 = 원본 계약기간매출(누락 시 대체하지 않음)",
        "수주 예정": `진행 중 A/C 전체, 수주년월을 수주 예정월로 사용(업무 가정), 기준월 ${ymLabel(p.base_ym)}; 경과는 기준월보다 이전인 경우만`,
        "가중 추정": "유효한 계약기간매출 × 입력 가능성(%) — 통계적으로 검증된 예측이 아닌 입력값 기반 참고치. 원본 '수주가능매출'과 동일시하지 않음",
        "수주율": "승패 결정 건 기준 수주율 = Win/(Win+Lose), Drop 분모 제외, 분모 0이면 산출 불가. 수주년월 기준 현재 종결상태",
      },
    };
  }

  // ================================================================ 화면: 재계약·해지
  function renewalView(ds, p) {
    const df = filterDf(ds, p);
    if (!df.length) return { empty: true };
    const rr = df.filter((r) => r.acr_type === "R");
    const prog = rr.filter((r) => isProg(r.status));
    const sums = (g) => ({ prev: fsum(g.map((r) => r.prev_monthly)), new: fsum(g.map((r) => r.new_monthly)), monthly: fsum(g.map((r) => r.monthly)) });
    const sched = BUCKETS.map((k) => { const g = prog.filter((r) => bucketOf(r.win_ym, p) === k); return Object.assign({ bucket: k, count: g.length }, sums(g)); });
    const done = rr.filter((r) => r.status === "재계약완료" && inPeriod(r.win_ym, p));
    const cls = (r) => (!nn(r.monthly) ? "미확인" : r.monthly > 0 ? "증액" : r.monthly === 0 ? "동일" : "감액");
    const change = ["증액", "동일", "감액", "미확인"].map((k) => { const g = done.filter((r) => cls(r) === k); return Object.assign({ class: k, count: g.length }, sums(g)); });
    const valid = done.filter((r) => gte(r.prev_monthly, Number.MIN_VALUE) && r.prev_monthly > 0 && nn(r.new_monthly));
    const sp = valid.reduce((a, r) => a + r.prev_monthly, 0), sn = valid.reduce((a, r) => a + r.new_monthly, 0);
    const churn = rr.filter((r) => r.status === "해지확정" && inPeriod(r.win_ym, p));
    const key = p.level === "am" ? "am_key" : "team";
    const byOrg = [];
    groupBy(churn, (r) => r[key]).forEach((g, k) => byOrg.push(Object.assign({ key: k, team: g[0].team, am: key === "am_key" ? g[0].am : null, count: g.length }, sums(g))));
    byOrg.sort((a, b) => b.count - a.count);
    const ck = computeChecks(rr, p);
    const rcodes = ["OVERDUE", "LARGE_RENEWAL", "RENEWAL_DECREASE", "STRATEGY_MISSING", "STALE", "LARGE_STALE", "UPDATE_MISSING"];
    return {
      schedule: sched, prog_amount: Object.assign({ count: prog.length }, sums(prog)), change,
      mismatch: done.filter((r) => r.issues.includes("R_AMOUNT_MISMATCH")).length,
      change_rate: { rate: valid.length && sp > 0 ? (sn - sp) / sp : null, included: valid.length, excluded: done.length - valid.length },
      done_count: done.length,
      churn: Object.assign({ count: churn.length }, sums(churn), { by_org: byOrg, reason: reasonTable(churn.map((r) => r.churn_reason)), type: reasonTable(churn.map((r) => r.churn_type)) }),
      check_counts: rcodes.map((c) => ({ code: c, label: RULE_MAP[c][2], action: RULE_MAP[c][3], count: rr.filter((r) => ck.get(r.row).codes.includes(c)).length })),
      checks: priorityRows(rr, p, ck, 50, rcodes),
      basis: {
        "재계약 예정": "R 진행 중 전체, 수주년월을 재계약 예정월로 사용(업무 가정). 기존 계약 만료일은 원본에 없어 표시하지 않음",
        "재계약 완료": `R 재계약완료, 수주년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)}; 증액/동일/감액은 월매출합계 부호 기준`,
        "증감률": "(변경매출 합계 − 기존매출 합계) / 기존매출 합계, 기존매출이 양수이고 변경매출이 있는 동일 대상만(행별 평균 아님)",
        "해지확정": `R 해지확정, 수주년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)} — 실제 해지·청구중단일이 없어 해지월로 단정하지 않음. 확정 ACR 합계에서 제외`,
        "미산출": "대상 집단·결과 정의가 확인되지 않아 재계약 성공률·고객 유지율은 산출하지 않음",
      },
    };
  }

  // ================================================================ 화면: 팀·AM
  const REQ_CODES = new Set(["YM_MISSING_WIN", "YM_MISSING_REV", "YM_ERROR_WIN", "YM_ERROR_REV", "MONTHLY_MISSING", "TERM_MISSING", "TERM_ZERO", "TERM_NEG", "TERM_FRACTION", "TEAM_MISSING", "AM_MISSING", "NUM_ERROR", "TYPE_UNKNOWN", "STATUS_UNKNOWN"]);
  function teamView(ds, p) {
    const df = filterDf(ds, p);
    if (!df.length) return { empty: true };
    const key = p.level === "am" ? "am_key" : "team";
    const acr = computeAcr(df, p.mode, p.ym_from, p.ym_to, p.products, ["A", "C"]);
    const acrOrg = {}; (key === "am_key" ? acr.by_am : acr.by_team).forEach((r) => { acrOrg[r.key] = r; });
    const ck = computeChecks(df, p);
    const immHi = ymAdd(p.base_ym, p.th.imminent_months);
    const isAc = (r) => r.acr_type === "A" || r.acr_type === "C";
    const rows = [];
    groupBy(df, (r) => r[key]).forEach((g, k) => {
      const pa = g.filter((r) => isProg(r.status) && isAc(r)), pr = g.filter((r) => isProg(r.status) && r.acr_type === "R");
      const win = g.filter((r) => isAc(r) && r.status === "Win" && inPeriod(r.win_ym, p));
      const rdone = g.filter((r) => r.acr_type === "R" && r.status === "재계약완료" && inPeriod(r.win_ym, p));
      const o = acrOrg[k] || {};
      rows.push({
        key: k, team: g[0].team, am: key === "am_key" ? g[0].am : null,
        prog_ac_count: pa.length, prog_ac_amount: fsum(pa.map((r) => r.contract_amt)),
        imminent: g.filter((r) => isProg(r.status) && nn(r.win_ym) && r.win_ym >= p.base_ym && r.win_ym <= immHi).length,
        overdue: g.filter((r) => isProg(r.status) && lt(r.win_ym, p.base_ym)).length,
        win_count: win.length, win_amount: fsum(win.map((r) => r.contract_amt)),
        acr_ac: o.AC || 0, acr_ac_funnels: o.funnels || 0, prog_r_count: pr.length, prog_r_prev: fsum(pr.map((r) => r.prev_monthly)),
        renewal_decrease_done: rdone.filter((r) => lt(r.monthly, 0)).length,
        renewal_decrease_expected: g.filter((r) => ck.get(r.row).codes.includes("RENEWAL_DECREASE")).length,
        churn: g.filter((r) => r.acr_type === "R" && r.status === "해지확정" && inPeriod(r.win_ym, p)).length,
        stale: g.filter((r) => isProg(r.status) && updState(r, p).stale).length,
        update_missing: g.filter((r) => isProg(r.status) && r.updated_at === null).length,
        missing_info: g.filter((r) => r.issues.some((i) => REQ_CODES.has(i))).length,
        check_funnels: g.filter((r) => ck.get(r.row).codes.length).length,
        check_level1: g.filter((r) => ck.get(r.row).level === 1).length,
      });
    });
    rows.sort((a, b) => (b.acr_ac || 0) - (a.acr_ac || 0));
    return {
      level: key === "am_key" ? "am" : "team", rows,
      basis: {
        "확정 A/C 월매출 증감액": `${MODES[p.mode]}, 매출발생년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)}`,
        "Win·재계약완료·해지확정": `수주년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)}`,
        "진행 중·임박·경과·미갱신": `현재 진행 중 전체, 기준일 ${p.base_date}, 임박=기준월~+${p.th.imminent_months}개월, 미갱신 ${p.th.stale_days}일 초과`,
        "최근 갱신": "최근영업활동내역 저장일시 기준(실제 고객 접촉일·활동 횟수 아님)",
        "필수정보 누락": "년월·월매출합계·계약기간·조직·유형·상태 누락/오류 또는 숫자 변환 실패",
        "성과등급": "목표·보유고객 규모 자료가 없어 자동 성과등급은 산출하지 않음",
      },
    };
  }

  // ================================================================ 화면: 고객·상품·입찰
  function insightView(ds, p) {
    const df = filterDf(ds, p);
    if (!df.length) return { empty: true };
    const acrAll = computeAcr(df, "start", p.ym_from, p.ym_to, null, p.types);
    const conRows = new Set(acrAll.included_rows);
    const cust = [];
    groupBy(df, (r) => r.customer === null ? "(고객사 미입력)" : r.customer).forEach((g, name) => {
      const inc = g.filter((r) => conRows.has(r.row));
      cust.push({ customer: name, funnels: g.length, in_progress: g.filter((r) => isProg(r.status)).length,
        acr: inc.reduce((a, r) => a + r.monthly, 0), churn: g.filter((r) => r.status === "해지확정").length,
        teams: Array.from(new Set(g.map((r) => r.team))).sort().join(", ") });
    });
    cust.sort((a, b) => b.funnels - a.funnels || (a.customer < b.customer ? -1 : a.customer > b.customer ? 1 : 0));
    const names = Array.from(new Set(df.flatMap((r) => r.product_names))).sort();
    const prod = names.map((nm) => {
      const has = df.filter((r) => r.product_names.includes(nm));
      const a = computeAcr(has, "start", p.ym_from, p.ym_to, [nm], p.types);
      const pa = has.filter((r) => isProg(r.status) && (r.acr_type === "A" || r.acr_type === "C"));
      return { product: nm, funnels: has.length, acr_A: a.totals.A, acr_C: a.totals.C, acr_R: a.totals.R, acr_ACR: a.totals.ACR,
        acr_funnels: a.totals.funnels, prog_ac_count: pa.length, prog_ac_contract_amt: fsum(pa.map((r) => r.contract_amt)) };
    });
    prod.sort((a, b) => b.funnels - a.funnels);
    const bids = df.filter((r) => r.bid_no !== null);
    const groups = [];
    groupBy(bids, (r) => r.bid_no).forEach((g, no) => {
      const nm = g.find((r) => r.bid_name !== null);
      groups.push({ bid_no: no, bid_name: nm ? nm.bid_name : null, funnels: g.length, rows: g.map((r) => rowRecord(r)) });
    });
    groups.sort((a, b) => b.funnels - a.funnels);
    const ac = df.filter((r) => (r.acr_type === "A" || r.acr_type === "C") && inPeriod(r.win_ym, p));
    const method = [];
    groupBy(ac, (r) => r.bid_method === null ? "(미입력)" : r.bid_method).forEach((g, m) => {
      const rec = { method: m, total: g.length };
      ["Pre Sales", "제안완료", "Win", "Lose", "Drop"].forEach((s) => { rec[s] = g.filter((r) => r.status === s).length; });
      rec.contract_amt = fsum(g.map((r) => r.contract_amt));
      method.push(rec);
    });
    method.sort((a, b) => b.total - a.total);
    const per = df.filter((r) => inPeriod(r.win_ym, p));
    const isAc = (r) => r.acr_type === "A" || r.acr_type === "C";
    return {
      customers: cust.slice(0, 200), customer_count_display: cust.length, products: prod,
      product_diff_count: df.filter((r) => r.issues.includes("PRODUCT_SUM_DIFF")).length,
      bid_groups: groups, bid_funnels: bids.length, bid_methods: method, qualification: reasonTable(ac.map((r) => r.qualification)),
      reasons: {
        win: reasonTable(per.filter((r) => isAc(r) && r.status === "Win").map((r) => r.winloss_reason)),
        lose: reasonTable(per.filter((r) => isAc(r) && r.status === "Lose").map((r) => r.winloss_reason)),
        drop: reasonTable(per.filter((r) => r.status === "Drop").map((r) => r.drop_reason)),
        churn_reason: reasonTable(per.filter((r) => r.status === "해지확정").map((r) => r.churn_reason)),
        churn_type: reasonTable(per.filter((r) => r.status === "해지확정").map((r) => r.churn_type)),
      },
      basis: {
        "고객": "고객사 표시명 기준(마스킹된 이름이 같아도 같은 고객으로 단정하지 않음). 고객 코드가 없어 고유·신규 고객 수와 유지율은 산출하지 않음",
        "고객 ACR": `매출개시월 기준 확정 ACR(월매출합계), 매출발생년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)}`,
        "상품 ACR": "선택 상품 슬롯(상품1~5)의 대응 월매출만 합산(Funnel 전체금액 반복 합산 없음)",
        "상품 계약기간매출": "선택 상품을 보유한 Funnel 전체금액, 고유 Funnel당 1회 반영",
        "R 변경매출": "상품별 배분 근거가 없어 배분하지 않음",
        "입찰": "같은 입찰공고번호의 Funnel을 묶어 보여줄 뿐 중복으로 처리·삭제하지 않음. 입찰 마감일은 원본에 없어 표시하지 않음",
        "입찰방식·사유": `수주년월 ${ymLabel(p.ym_from)}~${ymLabel(p.ym_to)}, 자유 입력 원문 그대로 집계`,
      },
    };
  }

  // ================================================================ 상세 목록(드릴다운)
  const DRILL_KEYS = ["scope", "status", "acr_type", "bucket", "imminent", "code", "team", "am_key", "ym", "product", "customer", "bid_no", "prob_bin", "period", "change", "level"];
  function drillRows(ds, p, drill) {
    const d = {};
    Object.entries(drill || {}).forEach(([k, v]) => { if (DRILL_KEYS.includes(k) && v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) d[k] = v; });
    const scope = d.scope || "all";
    const df = filterDf(ds, p, scope === "all" || scope === "quality");
    if (!df.length) return { rows: [], ck: new Map(), basis: new Map(), desc: "자료 없음" };
    const basis = acrBasis(df, p.mode, p.products);
    const ck = computeChecks(df, p);
    const desc = [];
    let rows = df;
    if (scope === "acr") {
      let [con] = contributions(df, p.mode, p.ym_from, p.ym_to, p.products);
      con = con.filter((x) => p.types.includes(x.acr_type));
      if (d.ym) { con = con.filter((x) => x.ym === Number(d.ym)); desc.push(`${ymLabel(Number(d.ym))} 반영`); }
      const s = new Set(con.map((x) => x.row));
      rows = rows.filter((r) => s.has(r.row));
      desc.push(`확정 ACR 포함(${MODES[p.mode]})`);
    } else if (scope === "acr_excluded") { rows = rows.filter((r) => { const b = basis.get(r.row); return b.confirmed && b.excl_reason; }); desc.push("확정 ACR 조건이나 계산 제외"); }
    else if (scope === "checks") { rows = rows.filter((r) => ck.get(r.row).codes.length); desc.push("우선 확인 대상"); }
    else if (scope === "in_progress") { rows = rows.filter((r) => isProg(r.status)); desc.push("진행 중"); }
    else if (scope === "quality") { rows = rows.filter((r) => r.issues.some((i) => i !== "OUT_OF_SCOPE_HQ")); desc.push("데이터 품질 확인 행"); }
    if (d.status) { const s = listOf(d.status); rows = rows.filter((r) => s.includes(r.status)); desc.push("상태=" + s.join("/")); }
    if (d.acr_type) { const s = listOf(d.acr_type); rows = rows.filter((r) => s.includes(r.acr_type)); desc.push("유형=" + s.join("/")); }
    if (d.bucket) { const s = listOf(d.bucket); rows = rows.filter((r) => s.includes(bucketOf(r.win_ym, p))); desc.push("일정=" + s.join("/")); }
    if (d.imminent) {
      const hi = ymAdd(p.base_ym, p.th.imminent_months);
      rows = rows.filter((r) => isProg(r.status) && nn(r.win_ym) && r.win_ym >= p.base_ym && r.win_ym <= hi);
      desc.push(`예정 임박(기준월~+${p.th.imminent_months}개월)`);
    }
    if (d.code) { const s = listOf(d.code); rows = rows.filter((r) => ck.get(r.row).codes.some((c) => s.includes(c))); desc.push("사유=" + s.map((c) => (RULE_MAP[c] ? RULE_MAP[c][2] : c)).join("/")); }
    if (d.level) rows = rows.filter((r) => ck.get(r.row).level === Number(d.level));
    if (d.team) { rows = rows.filter((r) => r.team === d.team); desc.push(`팀=${d.team}`); }
    if (d.am_key) { rows = rows.filter((r) => r.am_key === d.am_key); desc.push(`AM=${String(d.am_key).split("|").pop()}`); }
    if (d.product) { rows = rows.filter((r) => r.product_names.includes(d.product)); desc.push(`상품=${d.product}`); }
    if (d.customer) { rows = rows.filter((r) => (r.customer === null ? "(고객사 미입력)" : r.customer) === d.customer); desc.push(`고객사(표시명)=${d.customer}`); }
    if (d.bid_no) { rows = rows.filter((r) => r.bid_no === d.bid_no); desc.push(`입찰공고번호=${d.bid_no}`); }
    if (d.prob_bin) { rows = rows.filter((r) => probBin(r.prob) === d.prob_bin); desc.push(`가능성=${d.prob_bin}`); }
    if (d.period === "win_ym" || d.period === "rev_ym") { rows = rows.filter((r) => inPeriod(r[d.period], p)); desc.push((d.period === "win_ym" ? "수주년월" : "매출발생년월") + " 기간 내"); }
    if (d.change) {
      const f = { "증액": (r) => lt(0, r.monthly), "동일": (r) => r.monthly === 0, "감액": (r) => lt(r.monthly, 0), "미확인": (r) => !nn(r.monthly) }[d.change];
      if (f) rows = rows.filter(f);
      desc.push(`증감=${d.change}`);
    }
    return { rows, ck, basis, desc: desc.join(" · ") || "전체" };
  }
  const SORTABLE = ["funnel_id", "customer", "team", "am", "acr_type", "status", "win_ym", "rev_ym", "monthly", "contract_amt", "prev_monthly", "new_monthly", "updated_at", "level", "row"];
  function detailView(ds, p, drill, page, size, sort, desc, q) {
    let { rows, ck, basis, desc: dsc } = drillRows(ds, p, drill);
    if (!rows.length) return { rows: [], total: 0, page: 1, pages: 0, desc: dsc };
    if (q) { const ql = q.toLowerCase(); rows = rows.filter((r) => [r.customer, r.funnel_id, r.am, r.team].map((x) => x || "").join(" ").toLowerCase().includes(ql)); }
    sort = SORTABLE.includes(sort) ? sort : "row";
    const fn = sort === "level" ? (r) => ck.get(r.row).level : (r) => r[sort];
    rows = sortBy(rows, [[fn, !desc]]);
    const total = rows.length;
    size = Math.max(10, Math.min(Number(size) || 50, 500));
    const pages = Math.max(1, Math.ceil(total / size));
    page = Math.max(1, Math.min(Number(page) || 1, pages));
    const part = rows.slice((page - 1) * size, page * size);
    return { rows: part.map((r) => rowRecord(r, ck.get(r.row), { included: basis.get(r.row).included, reason: basis.get(r.row).excl_reason })), total, page, pages, size, desc: dsc };
  }
  function qualityView(ds, p) {
    if (ds.empty) return { empty: true, meta: ds.meta };
    const scope = ds.df.filter((r) => r.in_scope);
    const agg = scope.filter((r) => !r.agg_excluded);
    const metrics = ["start", "term"].map((mode) => {
      const b = acrBasis(agg, mode);
      const conf = Array.from(b.values()).filter((x) => x.confirmed);
      const ex = {}; conf.forEach((x) => { if (x.excl_reason) ex[x.excl_reason] = (ex[x.excl_reason] || 0) + 1; });
      return { metric: MODES[mode], confirmed_rows: conf.length, included: conf.filter((x) => x.included).length, excluded: ex };
    });
    return {
      meta: ds.meta, quality: ds.quality,
      summary: { source_rows: ds.df.length, in_scope_rows: scope.length, agg_rows: agg.length, agg_excluded_rows: scope.filter((r) => r.agg_excluded).length,
        future_update_rows: scope.filter((r) => updState(r, p).future).length, missing_update_rows: scope.filter((r) => r.updated_at === null).length },
      metrics,
    };
  }

  // ================================================================ 엑셀 내보내기 (app.py export 대응)
  function exportWorkbook(ds, p, drill, q) {
    const { rows: sel, ck, basis, desc } = drillRows(ds, p, drill);
    let rows = sel.map((r) => rowRecord(r, ck.get(r.row), { included: basis.get(r.row).included, reason: basis.get(r.row).excl_reason }));
    if (q) rows = rows.filter((r) => [r.customer, r.funnel_id, r.am, r.team].map((x) => x || "").join(" ").toLowerCase().includes(q.toLowerCase()));
    const u = CFG.SOURCE_UNIT;
    const cols = [["row", "원본행"], ["funnel_id", "Funnel번호"], ["customer", "고객사"], ["team", "팀"], ["am", "AM"], ["acr_type", "ACR유형"],
      ["status", "현재상황"], ["win_ym", "수주년월"], ["rev_ym", "매출발생년월"], ["term", "계약기간(월)"], ["monthly", `월매출합계(${u})`],
      ["contract_amt", `계약기간매출(${u})`], ["prev_monthly", `기존매출(${u})`], ["new_monthly", `변경매출(${u})`], ["prob", "수주(재계약)가능성"],
      ["products", "상품(월매출)"], ["updated_at", "최근 갱신일"], ["strategy_reg", "재계약전략 등록여부"], ["acr_included", "ACR 포함"],
      ["acr_excl_reason", "ACR 제외 사유"], ["checks", "확인 사유"], ["actions", "권장 확인 행동"], ["level", "우선순위 등급"], ["issues", "데이터 품질"]];
    const aoa = [cols.map((c) => c[1])].concat(rows.map((r) => cols.map(([k]) => {
      let v = r[k];
      if (Array.isArray(v)) v = v.join(", ");
      if (k === "acr_included") v = v ? "포함" : "제외";
      return v === undefined ? null : v;
    })));
    const summ = paramsSummary(p);
    const now = new Date();
    const cond = [["항목", "값"], ["생성시각", now.toLocaleString("ko-KR")], ["원본 파일", ds.meta.file_name], ["원본 적용 시각", ds.meta.uploaded_at],
      ["목록 조건", desc], ["목록 내 검색", q || "없음"], ["행 수", rows.length], ["금액 단위", `${u} (원본 값 그대로, 반올림 없음)`],
      ["계산 위치", "열람자 브라우저(서버 전송 없음)"]]
      .concat(Object.entries(summ).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : v]))
      .concat(Object.entries({
        "확정 ACR": "A=Acq.+Win, C=Cul.+Win, R=Ret.+재계약완료; 월매출합계(증감액) 기준, 음수 유지",
        "매출개시월 기준": "월매출합계를 매출발생년월에 1회 배치",
        "계약기간 반영 추정": "매출발생년월부터 계약기간(월) 동안 매월 반영, 시작월 포함·일할 없음, 추정치",
        "중복": "Funnel번호 중복·누락 행은 검토 전 집계 제외(목록에는 표시)",
        "우선 확인": "설명 가능한 조건 규칙(수주 확률·AM 평가점수 아님)",
      }).map(([k, v]) => ["지표 정의: " + k, v]));
    const rules = [["code", "level", "label", "action", "condition"]].concat(rulesTable(p).map((r) => [r.code, r.level, r.label, r.action, r.condition]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "목록");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cond), "조건_정의");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rules), "확인규칙");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const z = (n) => String(n).padStart(2, "0");
    return { data: out, rows: rows.length,
      filename: `public_sales_${p.base_date.replace(/-/g, "")}_${z(now.getHours())}${z(now.getMinutes())}${z(now.getSeconds())}.xlsx` };
  }

  // ================================================================ 저장소(메모리) · API 대응 디스패처
  const state = { ds: emptyDataset(), staged: {} };
  function stage(buf, fileName) {
    const ext = (String(fileName).match(/\.[^.]+$/) || [""])[0].toLowerCase();
    if (ext !== ".xlsx") throw new LoadError(`지원하지 않는 확장자입니다(${ext || "없음"}). .xlsx 파일만 업로드할 수 있습니다.`);
    if (!buf || !buf.byteLength) throw new LoadError("빈 파일입니다.");
    if (buf.byteLength > CFG.MAX_UPLOAD_MB * 1024 * 1024) throw new LoadError(`파일 크기가 제한(${CFG.MAX_UPLOAD_MB}MB)을 초과합니다.`);
    const u8 = new Uint8Array(buf, 0, 4);
    if (!(u8[0] === 0x50 && u8[1] === 0x4b)) throw new LoadError("엑셀(.xlsx) 형식이 아니거나 손상된 파일입니다.");
    const ds = buildDataset(readWorkbook(buf), fileName, "검증 중");
    const token = Math.random().toString(16).slice(2) + Date.now().toString(16);
    state.staged = { [token]: { buf, fileName } };
    return { token, meta: ds.meta, quality: ds.quality };
  }
  function apply(token, appliedAt) {
    const s = state.staged[token];
    if (!s) throw new LoadError("검증된 파일을 찾을 수 없습니다. 다시 선택하세요.");
    const ds = buildDataset(readWorkbook(s.buf), s.fileName, appliedAt || new Date().toLocaleString("ko-KR"));
    state.ds = ds; state.staged = {};
    return ds;
  }
  function setDataset(ds) { state.ds = ds; }
  function loadParsed(parsed, fileName, at, extra) { state.ds = buildDataset(parsed, fileName, at, extra); return state.ds; }

  const VIEWS = { overview: overviewView, funnel: funnelView, renewal: renewalView, acr: acrView, team: teamView, insight: insightView, quality: qualityView };
  function envelope(view, p, data) {
    const d = state.ds;
    return { ok: true, view, dataset: { empty: d.empty, file_name: d.meta.file_name, uploaded_at: d.meta.uploaded_at, rows: d.meta.row_count || 0,
      agg_excluded_rows: d.empty ? 0 : d.quality.agg_excluded_rows, reason: d.meta.reason, sample: !!d.meta.sample }, applied: paramsSummary(p), data };
  }
  function meta() {
    const d = state.ds;
    let teams = [], ams = [], products = [];
    if (!d.empty) {
      const sc = d.df.filter((r) => r.in_scope);
      teams = Array.from(new Set(sc.map((r) => r.team))).sort();
      ams = Array.from(new Set(sc.map((r) => r.am_key))).sort().map((k) => ({ key: k, team: k.split("|")[0], am: k.split("|").slice(1).join("|") }));
      products = Array.from(new Set(sc.flatMap((r) => r.product_names))).sort();
    }
    const p = parseParams({});
    return {
      ok: true, dataset: Object.assign({ empty: d.empty }, d.meta),
      options: { teams, ams, products, modes: MODES, types: CFG.ACR_TYPE_LABEL },
      defaults: { base_date: p.base_date, ym_from: ymLabel(p.ym_from), ym_to: ymLabel(p.ym_to), th: Object.assign({}, CFG.BUSINESS_DEFAULTS) },
      unit: { source_unit: CFG.SOURCE_UNIT, units: ["원", "천원", "백만원", "억원"] },
      rules: rulesTable(p), admin_required: false,
      settings: { URL_PREFIX: "(정적 페이지 — 해당 없음)", TARGET_HQ: CFG.TARGET_HQ, MAX_UPLOAD_MB: CFG.MAX_UPLOAD_MB },
    };
  }
  // app.js 의 api(path, body) 를 대신한다
  function call(path, body) {
    body = body || {};
    const p = parseParams(body.filters || {});
    if (path === "/meta") return meta();
    let m = path.match(/^\/view\/(\w+)$/);
    if (m) {
      if (!VIEWS[m[1]]) throw new Error("알 수 없는 화면");
      if (state.ds.empty && m[1] !== "quality") return envelope(m[1], p, { empty: true });
      const data = VIEWS[m[1]](state.ds, p);
      if (["overview", "funnel", "renewal", "team", "acr"].includes(m[1])) data.rules = rulesTable(p);
      return envelope(m[1], p, data);
    }
    if (path === "/detail") {
      if (state.ds.empty) return envelope("detail", p, { rows: [], total: 0, desc: "자료 없음" });
      return envelope("detail", p, detailView(state.ds, p, body.drill, body.page, body.size, body.sort, !!body.desc, String(body.q || "").slice(0, 100)));
    }
    m = path.match(/^\/raw\/(\d+)$/);
    if (m) { const r = state.ds.byRow[Number(m[1])]; if (!r) throw new Error("행을 찾을 수 없습니다."); return { ok: true, row: r }; }
    throw new Error("알 수 없는 요청");
  }

  root.PSD = {
    CFG, LoadError, ISSUE_LABELS, RULES, MODES,
    parsers: { cleanStr, parseNum, parseYm, parseDate, parseProb },
    ym: { ymAdd, ymRange, ymDiff, ymLabel },
    readWorkbook, buildDataset, computeAcr, parseParams, filterDf, computeChecks,
    views: VIEWS, detailView, drillRows, exportWorkbook,
    stage, apply, setDataset, loadParsed, call, getDataset: () => state.ds,
  };
})(typeof window !== "undefined" ? window : globalThis);
