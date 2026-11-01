/* 예시 데이터 생성기 — 팀·AM은 실제 조직(원본 엑셀 기준), 고객·금액·건수·일정은 가상 값인 화면 시연용 데이터.
 * 열람자가 엑셀을 선택하면 이 데이터는 사용되지 않는다. */
(function (root) {
  "use strict";
  const HEADERS = ["고객사", "수주년월", "월매출합계", "현재상황", "최근영업활동내용", "팀", "모듈", "AM", "ACR유형", "Culti 상세", "Ret.상세",
    "계약기간(월)", "매출발생년월", "Funnel번호", "본부", "연매출", "계약기간매출", "수주(재계약)가능성", "기존매출", "변경매출",
    "Biz1", "상품1", "월매출1", "Biz2", "상품2", "월매출2", "Biz3", "상품3", "월매출3", "Biz4", "상품4", "월매출4", "Biz5", "상품5", "월매출5",
    "최근영업활동내역 저장일시", "확정자", "확정일자", "재계약전략 등록여부", "입찰방식", "참가자격", "승패사유", "Drop세부사유", "해지사유",
    "해지유형", "입찰공고번호", "입찰공고명", "수주예상금액", "수주가능매출", "RMR제외", "중대형퍼널제외"];

  const ROSTER = {"공공고객팀": ["강성욱", "김명진", "김재완", "김진우", "김태용", "나철오", "남현철", "배현우", "서강원", "신흥우", "오정윤", "윤세홍", "이상엽", "이용성", "장대식", "지성환", "최동현", "최태완", "홍성표"], "동부기업고객1팀": ["김규완", "김장환", "김현수", "남우근", "문창규", "변종석", "장성민", "장소용"], "동부기업고객2팀": ["김동규", "김영우", "김정환", "배민호", "석헌철", "송인선", "임도선", "최광호", "최중혁"], "중부기업고객팀": ["김기민", "김승현", "서세욱", "손신현", "양기림", "윤창구", "이병한", "이택기", "임병주", "최인규"], "서부기업고객팀": ["강호신", "고병진", "구현진", "신용구", "신종백", "이창환", "장희욱", "정은택", "최연석"]};

  function build(baseDate) {
    let seed = 20261101;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const round2 = (x) => Math.round(x * 100) / 100;
    const [by, bm] = baseDate.split("-").map(Number);
    const ym = (off) => { const t = by * 12 + (bm - 1) + off; return Math.floor(t / 12) * 100 + (t % 12) + 1; };
    const z = (n) => String(n).padStart(2, "0");
    const dayStr = (offDays) => { const d = new Date(Date.UTC(by, bm - 1, 1) + offDays * 86400000); return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}`; };
    // 실제 팀·AM 배정(유선Funnel 원본 기준). 금액·건수·고객은 가상 값이며 해당 AM의 실제 실적이 아님
    const ams = [];
    Object.entries(ROSTER).forEach(([t, list]) => list.forEach((a) => ams.push([t, a])));
    const products = [["Core", "국내전용"], ["Core", "인터넷"], ["Growth", "Managed_서비스형"], ["Growth", "Cloud X_구축형"], ["Core", "CDN"], ["Growth", "보안관제"]];
    const winReasons = ["영업력(인적네트워크)", "서비스품질 및 인프라", "가격경쟁력", "고객사의 전략적 제휴"];
    const loseReasons = ["가격경쟁력", "영업력(인적네트워크)", "당사_Infra 투자 과다"];
    const rows = [];
    for (let i = 0; i < 440; i++) {
      const [team, am] = pick(ams);
      const r = {};
      const tRoll = rnd();
      const type = tRoll < 0.22 ? "Acq." : tRoll < 0.68 ? "Cul." : "Ret.";
      const sRoll = rnd();
      let status;
      if (type === "Ret.") status = sRoll < 0.3 ? "Pre Sales" : sRoll < 0.33 ? "제안완료" : sRoll < 0.8 ? "재계약완료" : "해지확정";
      else status = sRoll < 0.2 ? "Pre Sales" : sRoll < 0.24 ? "제안완료" : sRoll < 0.78 ? "Win" : sRoll < 0.86 ? "Lose" : "Drop";
      const prog = status === "Pre Sales" || status === "제안완료";
      const winOff = prog ? Math.floor(rnd() * 4) - 1 - (rnd() < 0.12 ? 2 : 0) : -Math.floor(rnd() * 10);
      const win = ym(winOff);
      const rev = ym(winOff + Math.floor(rnd() * 3));
      const term = pick([12, 24, 36, 36, 36, 60, 60, 1, 6]);
      let monthly, prev = 0, nw = 0;
      if (type === "Ret.") {
        prev = round2(0.2 + rnd() * (rnd() < 0.1 ? 60 : 8));
        const ch = rnd();
        nw = ch < 0.6 ? prev : ch < 0.85 ? round2(prev * (0.85 + rnd() * 0.1)) : round2(prev * (1 + rnd() * 0.15));
        if (status === "해지확정") nw = 0;
        monthly = round2(nw - prev);
      } else monthly = round2(0.05 + rnd() * (rnd() < 0.08 ? 40 : 4));
      const [biz, prod] = pick(products);
      r["고객사"] = `예시기관${String(1 + Math.floor(rnd() * 140)).padStart(3, "0")}`;
      r["수주년월"] = win; r["월매출합계"] = monthly; r["현재상황"] = status; r["최근영업활동내용"] = "(예시 데이터)";
      r["팀"] = team; r["AM"] = am; r["ACR유형"] = type; r["계약기간(월)"] = term; r["매출발생년월"] = rev;
      r["Funnel번호"] = `EX${String(i + 1).padStart(5, "0")}`; r["본부"] = "공공고객담당";
      r["계약기간매출"] = round2((type === "Ret." ? nw : monthly) * term); r["연매출"] = round2(monthly * 12);
      const prob = prog ? pick(["10%(하하)", "30%(하상)", "50%(중중)", "50%(중중)", "70%(상하)", "90%(상상)", "1%(Tapping)"]) : status === "Win" || status === "재계약완료" ? "100%(수주완료)" : status === "Drop" ? "0%(DROP)" : "0%(수주실패)";
      r["수주(재계약)가능성"] = prob; r["기존매출"] = prev; r["변경매출"] = nw;
      r["Biz1"] = biz; r["상품1"] = prod; r["월매출1"] = monthly;
      r["최근영업활동내역 저장일시"] = rnd() < 0.03 ? null : dayStr(-Math.floor(rnd() * (prog ? 75 : 200)));
      r["재계약전략 등록여부"] = rnd() < 0.1 ? "Y" : "N";
      r["입찰방식"] = pick(["수의계약", "수의계약", "자체입찰", "조달입찰", null]);
      r["참가자격"] = pick(["기간통신사업자", "일반", null]);
      if (status === "Win") r["승패사유"] = pick(winReasons);
      if (status === "Lose") r["승패사유"] = pick(loseReasons);
      if (status === "Drop") r["Drop세부사유"] = "고객_사업기회 소멸&불투명";
      if (status === "해지확정") { r["해지사유"] = pick(["예산 축소", "타사 전환", null]); r["해지유형"] = pick(["서비스단위 해지", "전체 해지"]); }
      if (rnd() < 0.05) { r["입찰공고번호"] = `EX-BID-${1 + Math.floor(rnd() * 6)}`; r["입찰공고명"] = "예시 통신망 구축 사업"; }
      r["RMR제외"] = "N"; r["중대형퍼널제외"] = rnd() < 0.05 ? "Y" : "N";
      rows.push(r);
    }
    return { sheet: "예시데이터", headerRow: 1, headers: HEADERS, rows: rows.map((r, i) => ({ excelRow: i + 2, values: HEADERS.map((h) => (h in r ? r[h] : null)) })) };
  }
  root.PSD_SAMPLE = { build };
})(typeof window !== "undefined" ? window : globalThis);
