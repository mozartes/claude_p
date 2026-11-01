"""원본 엑셀 읽기·검증·정규화 및 데이터 저장소.

원칙
- 원본 파일은 DATA_DIR/raw 에 그대로 보존하고, 원본 셀 값(raw_rows)과 정규화 값(df)을 분리 보관한다.
- 열은 번호가 아니라 헤더 이름으로 연결한다.
- 행을 조용히 버리지 않는다. 문제 행은 issues 코드로 표시하고 지표별 포함 여부는 계산 단계에서 결정한다.
- 업로드는 '검증(staging) → 미리보기 → 적용' 2단계이며, 적용은 완전히 만들어진 데이터셋을
  잠금 안에서 한 번에 교체한다(조회 중 사용자에게 불완전한 데이터가 보이지 않음).
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
from openpyxl import load_workbook

import config as C

log = logging.getLogger("dashboard.data")

ALLOWED_EXT = {".xlsx"}

# ---------------------------------------------------------------- 값 파서


def clean_str(v: Any) -> str | None:
    """앞뒤 공백·줄바꿈 제거. 빈 문자열은 None(누락)."""
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    s = str(v).replace("\r", " ").replace("\n", " ").strip()
    s = re.sub(r"\s{2,}", " ", s)
    return s or None


def parse_num(v: Any) -> tuple[float | None, bool]:
    """숫자 변환. (값, 오류여부). 누락은 (None, False), 변환 실패는 (None, True). 0·음수 유지."""
    if v is None:
        return None, False
    if isinstance(v, bool):
        return None, True
    if isinstance(v, (int, float)):
        if isinstance(v, float) and pd.isna(v):
            return None, False
        return float(v), False
    s = clean_str(v)
    if s is None:
        return None, False
    s2 = s.replace(",", "")
    try:
        return float(s2), False
    except ValueError:
        return None, True


_EXCEL_EPOCH = dt.datetime(1899, 12, 30)


def _valid_ym(y: int, m: int) -> int | None:
    if 1990 <= y <= 2100 and 1 <= m <= 12:
        return y * 100 + m
    return None


def parse_ym(v: Any) -> tuple[int | None, bool]:
    """년월 → YYYYMM 정수. YYYYMM / YYYY-MM / YYYY.MM / YYYY/MM / 날짜 / Excel 일련번호 허용."""
    if v is None:
        return None, False
    if isinstance(v, (dt.datetime, dt.date)):
        return _valid_ym(v.year, v.month), _valid_ym(v.year, v.month) is None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if isinstance(v, float) and pd.isna(v):
            return None, False
        if float(v).is_integer():
            iv = int(v)
            if 199001 <= iv <= 210012:
                r = _valid_ym(iv // 100, iv % 100)
                return r, r is None
            if 20000 <= iv <= 80000:  # Excel 날짜 일련번호
                d = _EXCEL_EPOCH + dt.timedelta(days=iv)
                return _valid_ym(d.year, d.month), False
        return None, True
    s = clean_str(v)
    if s is None:
        return None, False
    m = re.fullmatch(r"(\d{4})(\d{2})", s) or re.fullmatch(r"(\d{4})\s*[-./년]\s*(\d{1,2})\s*월?", s)
    if not m:
        m = re.match(r"(\d{4})[-./](\d{1,2})[-./]\d{1,2}", s)
    if m:
        r = _valid_ym(int(m.group(1)), int(m.group(2)))
        return r, r is None
    return None, True


def parse_date(v: Any) -> tuple[pd.Timestamp | None, bool]:
    if v is None:
        return None, False
    if isinstance(v, (dt.datetime, dt.date)):
        return pd.Timestamp(v).normalize(), False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if isinstance(v, float) and pd.isna(v):
            return None, False
        iv = int(v)
        if 19900101 <= iv <= 21001231:
            try:
                return pd.Timestamp(dt.datetime.strptime(str(iv), "%Y%m%d")), False
            except ValueError:
                return None, True
        if 20000 <= iv <= 80000:
            return pd.Timestamp(_EXCEL_EPOCH + dt.timedelta(days=iv)).normalize(), False
        return None, True
    s = clean_str(v)
    if s is None:
        return None, False
    m = re.match(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})", s) or re.fullmatch(r"(\d{4})(\d{2})(\d{2})", s)
    if m:
        try:
            return pd.Timestamp(int(m.group(1)), int(m.group(2)), int(m.group(3))), False
        except ValueError:
            return None, True
    return None, True


_PROB_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*%")


def parse_prob(v: Any) -> float | None:
    """'50%(중중)' → 50.0. 명시적인 0~100% 값만 인정, 나머지는 None(미확인)."""
    s = clean_str(v)
    if s is None:
        return None
    m = _PROB_RE.match(s)
    if not m:
        return None
    p = float(m.group(1))
    return p if 0 <= p <= 100 else None


def raw_display(v: Any) -> Any:
    """원본 셀 값을 JSON 표시용으로 보존(가공 없음)."""
    if v is None:
        return None
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, float) and pd.isna(v):
        return None
    return v


# ---------------------------------------------------------------- 결과 구조


@dataclass
class Dataset:
    df: pd.DataFrame
    raw_rows: list[dict]
    headers: list[str]
    meta: dict
    quality: dict
    empty: bool = False
    by_row: dict = field(default_factory=dict)


ISSUE_LABELS = {
    "FUNNEL_BLANK": "Funnel번호 없음(집계 제외)",
    "FUNNEL_DUP": "Funnel번호 중복(검토 전 집계 제외)",
    "TYPE_UNKNOWN": "알 수 없는 ACR유형",
    "STATUS_UNKNOWN": "알 수 없는 현재상황",
    "NUM_ERROR": "숫자 변환 실패",
    "YM_ERROR_WIN": "수주년월 형식 오류",
    "YM_ERROR_REV": "매출발생년월 형식 오류",
    "YM_MISSING_WIN": "수주년월 누락",
    "YM_MISSING_REV": "매출발생년월 누락",
    "MONTHLY_MISSING": "월매출합계 누락",
    "TERM_MISSING": "계약기간 누락",
    "TERM_ZERO": "계약기간 0",
    "TERM_NEG": "계약기간 음수",
    "TERM_FRACTION": "계약기간 소수",
    "TEAM_MISSING": "팀 미입력",
    "AM_MISSING": "AM 미입력",
    "PRODUCT_SUM_DIFF": "상품별 월매출 합계 ≠ 월매출합계",
    "R_AMOUNT_MISMATCH": "R: 변경매출−기존매출 ≠ 월매출합계",
    "DATE_ERROR_UPDATE": "최근 갱신일 형식 오류",
    "OUT_OF_SCOPE_HQ": "대상 본부 외",
}


class LoadError(Exception):
    """적용 불가 오류(파일 손상·필수 열 누락 등)."""


# ---------------------------------------------------------------- 파일 검증·읽기


def validate_file_basic(path: Path, original_name: str) -> None:
    ext = Path(original_name).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise LoadError(f"지원하지 않는 확장자입니다({ext or '없음'}). .xlsx 파일만 업로드할 수 있습니다.")
    size = path.stat().st_size
    if size == 0:
        raise LoadError("빈 파일입니다.")
    if size > C.MAX_UPLOAD_MB * 1024 * 1024:
        raise LoadError(f"파일 크기가 제한({C.MAX_UPLOAD_MB:.0f}MB)을 초과합니다.")
    if not zipfile.is_zipfile(path):
        raise LoadError("엑셀(.xlsx) 형식이 아니거나 손상된 파일입니다.")


def _find_sheet_and_header(wb) -> tuple[Any, int, list[str]]:
    candidates = []
    if C.SHEET_NAME_PREFERRED in wb.sheetnames:
        candidates.append(wb[C.SHEET_NAME_PREFERRED])
    candidates += [ws for ws in wb.worksheets if ws.title != C.SHEET_NAME_PREFERRED]
    best = None
    for ws in candidates:
        for r_idx, row in enumerate(ws.iter_rows(min_row=1, max_row=10, values_only=True), start=1):
            headers = [clean_str(h) or "" for h in row]
            hit = sum(1 for h in C.REQUIRED_COLUMNS if h in headers)
            if best is None or hit > best[3]:
                best = (ws, r_idx, headers, hit)
            if hit == len(C.REQUIRED_COLUMNS):
                return ws, r_idx, headers
    if best is None:
        raise LoadError("시트를 찾을 수 없습니다.")
    missing = [h for h in C.REQUIRED_COLUMNS if h not in best[2]]
    raise LoadError(
        f"필수 열이 없습니다: {', '.join(missing)} (시트 '{best[0].title}' {best[1]}행 기준). "
        "헤더 이름이 원본 Funnel 조회 양식과 같은지 확인하세요."
    )


def read_workbook(path: Path) -> tuple[str, int, list[str], list[tuple]]:
    try:
        wb = load_workbook(path, read_only=True, data_only=True)
    except Exception as e:  # 손상 파일
        raise LoadError(f"엑셀 파일을 열 수 없습니다(손상 또는 암호화 가능성): {type(e).__name__}") from e
    try:
        ws, header_row, headers = _find_sheet_and_header(wb)
        rows = []
        for row in ws.iter_rows(min_row=header_row + 1, values_only=True):
            if row is None or all(v is None or (isinstance(v, str) and v.strip() == "") for v in row):
                continue  # 완전히 빈 행만 건너뜀(데이터 아님)
            rows.append(row)
        return ws.title, header_row, headers, rows
    finally:
        wb.close()


# ---------------------------------------------------------------- 정규화


def _norm_type(v: Any) -> str | None:
    s = clean_str(v)
    if s is None:
        return None
    return C.ACR_TYPE_MAP.get(s.lower())


def build_dataset(path: Path, original_name: str, uploaded_at: str) -> Dataset:
    t0 = time.perf_counter()
    sheet, header_row, headers, rows = read_workbook(path)
    # 같은 헤더 이름이 여러 번 나오면 첫 번째를 사용하고 기록
    idx: dict[str, int] = {}
    dup_headers = []
    for i, h in enumerate(headers):
        if not h:
            continue
        if h in idx:
            dup_headers.append(h)
            continue
        idx[h] = i

    def get(row, name):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else None

    known_cols = set(C.COL.values()) | {f"{p}{k}" for k in range(1, C.PRODUCT_SLOTS + 1) for p in ("Biz", "상품", "월매출")}
    missing_optional = sorted(v for v in C.COL.values() if v not in idx)
    for k in range(1, C.PRODUCT_SLOTS + 1):
        for p in ("Biz", "상품", "월매출"):
            if f"{p}{k}" not in idx:
                missing_optional.append(f"{p}{k}")

    raw_rows: list[dict] = []
    recs: list[dict] = []
    status_set = set(C.KNOWN_STATUSES)
    for n, row in enumerate(rows):
        excel_row = header_row + 1 + n
        raw = {h: raw_display(get(row, h)) for h in headers if h}
        raw_rows.append({"_row": excel_row, **raw})
        issues: list[str] = []
        num_err_cols: list[str] = []

        def num(name):
            v, err = parse_num(get(row, name))
            if err:
                num_err_cols.append(name)
            return v

        fid = clean_str(get(row, C.COL["funnel_id"]))
        team = clean_str(get(row, C.COL["team"]))
        am = clean_str(get(row, C.COL["am"]))
        hq = clean_str(get(row, C.COL["hq"]))
        acr_raw = clean_str(get(row, C.COL["acr_type"]))
        acr = _norm_type(acr_raw)
        status = clean_str(get(row, C.COL["status"]))
        win_ym, win_err = parse_ym(get(row, C.COL["win_ym"]))
        rev_ym, rev_err = parse_ym(get(row, C.COL["rev_ym"]))
        monthly = num(C.COL["monthly"])
        term_raw = get(row, C.COL["term"])
        term_v, term_err = parse_num(term_raw)
        term = None
        if term_err:
            num_err_cols.append(C.COL["term"])
            issues.append("TERM_MISSING")
        elif term_v is None:
            issues.append("TERM_MISSING")
        elif term_v == 0:
            issues.append("TERM_ZERO")
        elif term_v < 0:
            issues.append("TERM_NEG")
        elif not float(term_v).is_integer():
            issues.append("TERM_FRACTION")
        else:
            term = int(term_v)
        upd, upd_err = parse_date(get(row, C.COL["updated_at"]))
        conf_at, _ = parse_date(get(row, C.COL["confirmed_at"]))

        products = []
        psum = 0.0
        has_pamt = False
        for k in range(1, C.PRODUCT_SLOTS + 1):
            biz = clean_str(get(row, f"Biz{k}"))
            prod = clean_str(get(row, f"상품{k}"))
            amt, aerr = parse_num(get(row, f"월매출{k}"))
            if aerr:
                num_err_cols.append(f"월매출{k}")
            if biz is None and prod is None and amt is None:
                continue
            products.append({"slot": k, "biz": biz, "product": prod, "amount": amt})
            if amt is not None:
                psum += amt
                has_pamt = True

        rec = {
            "row": excel_row,
            "funnel_id": fid,
            "customer": clean_str(get(row, C.COL["customer"])),
            "hq": hq,
            "team": team or C.UNASSIGNED_ORG,
            "am": am or C.UNASSIGNED_ORG,
            "module": clean_str(get(row, C.COL["module"])),
            "acr_raw": acr_raw,
            "acr_type": acr,
            "culti_detail": clean_str(get(row, C.COL["culti_detail"])),
            "ret_detail": clean_str(get(row, C.COL["ret_detail"])),
            "status_raw": get(row, C.COL["status"]),
            "status": status,
            "win_ym": win_ym,
            "rev_ym": rev_ym,
            "term": term,
            "term_raw": raw_display(term_raw),
            "monthly": monthly,
            "contract_amt": num(C.COL["contract_amt"]),
            "annual": num(C.COL["annual"]),
            "prev_monthly": num(C.COL["prev_monthly"]),
            "new_monthly": num(C.COL["new_monthly"]),
            "possible_rev": num(C.COL["possible_rev"]),
            "prob_raw": clean_str(get(row, C.COL["prob"])),
            "prob": parse_prob(get(row, C.COL["prob"])),
            "updated_at": upd,
            "confirmer": clean_str(get(row, C.COL["confirmer"])),
            "confirmed_at": conf_at,
            "strategy_reg": clean_str(get(row, C.COL["strategy_reg"])),
            "bid_method": clean_str(get(row, C.COL["bid_method"])),
            "qualification": clean_str(get(row, C.COL["qualification"])),
            "winloss_reason": clean_str(get(row, C.COL["winloss_reason"])),
            "drop_reason": clean_str(get(row, C.COL["drop_reason"])),
            "churn_reason": clean_str(get(row, C.COL["churn_reason"])),
            "churn_type": clean_str(get(row, C.COL["churn_type"])),
            "bid_no": clean_str(get(row, C.COL["bid_no"])),
            "bid_name": clean_str(get(row, C.COL["bid_name"])),
            "expected_amt": clean_str(get(row, C.COL["expected_amt"])),
            "rmr_excl": clean_str(get(row, C.COL["rmr_excl"])),
            "midlarge_excl": clean_str(get(row, C.COL["midlarge_excl"])),
            "products": products,
            "product_names": sorted({p["product"] for p in products if p["product"]}),
            "product_sum": psum if has_pamt else None,
            "num_error_cols": sorted(set(num_err_cols)),
        }
        rec["am_key"] = f"{rec['team']}|{rec['am']}"
        if fid is None:
            issues.append("FUNNEL_BLANK")
        if acr is None:
            issues.append("TYPE_UNKNOWN")
        if status not in status_set:
            issues.append("STATUS_UNKNOWN")
        if num_err_cols:
            issues.append("NUM_ERROR")
        if win_err:
            issues.append("YM_ERROR_WIN")
        elif win_ym is None:
            issues.append("YM_MISSING_WIN")
        if rev_err:
            issues.append("YM_ERROR_REV")
        elif rev_ym is None:
            issues.append("YM_MISSING_REV")
        if monthly is None and C.COL["monthly"] not in num_err_cols:
            issues.append("MONTHLY_MISSING")
        if team is None:
            issues.append("TEAM_MISSING")
        if am is None:
            issues.append("AM_MISSING")
        if upd_err:
            issues.append("DATE_ERROR_UPDATE")
        if has_pamt and monthly is not None and abs(psum - monthly) > 1e-6:
            issues.append("PRODUCT_SUM_DIFF")
        if acr == "R" and None not in (monthly, rec["prev_monthly"], rec["new_monthly"]):
            if abs((rec["new_monthly"] - rec["prev_monthly"]) - monthly) > 1e-6:
                issues.append("R_AMOUNT_MISMATCH")
        if hq != C.TARGET_HQ:
            issues.append("OUT_OF_SCOPE_HQ")
        rec["issues"] = issues
        recs.append(rec)

    df = pd.DataFrame(recs)
    if df.empty:
        raise LoadError("데이터 행이 없습니다.")
    # 중복 Funnel번호: 그룹 전체를 검토 대상으로 표시하고 집계에서 제외(임의 병합·삭제 없음)
    ids = df["funnel_id"]
    dup_mask = ids.notna() & ids.duplicated(keep=False)
    df["dup_group"] = None
    df.loc[dup_mask, "dup_group"] = ids[dup_mask]
    df.loc[dup_mask, "issues"] = df.loc[dup_mask, "issues"].apply(lambda x: x + ["FUNNEL_DUP"])
    df["agg_excluded"] = df["issues"].apply(lambda x: "FUNNEL_DUP" in x or "FUNNEL_BLANK" in x)
    df["in_scope"] = df["hq"] == C.TARGET_HQ
    for c in ("win_ym", "rev_ym", "term"):
        df[c] = df[c].astype("Int64")
    for c in ("monthly", "contract_amt", "annual", "prev_monthly", "new_monthly", "possible_rev", "prob", "product_sum"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype(float)
    df["updated_at"] = pd.to_datetime(df["updated_at"])
    df = df.set_index("row", drop=False)
    df.index.name = None

    quality = build_quality(df, dup_headers)
    meta = {
        "file_name": original_name,
        "uploaded_at": uploaded_at,
        "sheet": sheet,
        "header_row": header_row,
        "row_count": int(len(df)),
        "column_count": len([h for h in headers if h]),
        "missing_optional_columns": missing_optional,
        "unknown_columns": sorted(h for h in headers if h and h not in known_cols),
        "duplicate_headers": dup_headers,
        "load_seconds": round(time.perf_counter() - t0, 3),
        "target_hq": C.TARGET_HQ,
    }
    log.info(
        "dataset built: rows=%d sheet=%s dup_groups=%d issues_rows=%d seconds=%.3f",
        len(df), sheet, quality["dup_group_count"], quality["rows_with_issues"], meta["load_seconds"],
    )
    return Dataset(df=df, raw_rows=raw_rows, headers=[h for h in headers if h], meta=meta, quality=quality,
                   by_row={r["_row"]: r for r in raw_rows})


def build_quality(df: pd.DataFrame, dup_headers: list[str]) -> dict:
    counts: dict[str, int] = {}
    for iss in df["issues"]:
        for code in set(iss):
            counts[code] = counts.get(code, 0) + 1
    dup = df[df["dup_group"].notna()]
    groups = []
    for fid, g in dup.groupby("dup_group"):
        groups.append({"funnel_id": fid, "rows": [int(r) for r in g["row"]], "count": int(len(g))})
    unknown_types = sorted({str(x) for x in df.loc[df["acr_type"].isna(), "acr_raw"].dropna()})
    unknown_status = sorted({str(x) for x in df.loc[~df["status"].isin(C.KNOWN_STATUSES), "status"].dropna()})
    return {
        "source_rows": int(len(df)),
        "in_scope_rows": int(df["in_scope"].sum()),
        "agg_excluded_rows": int(df["agg_excluded"].sum()),
        "dup_group_count": len(groups),
        "dup_groups": groups,
        "issue_counts": [
            {"code": k, "label": ISSUE_LABELS.get(k, k), "rows": v}
            for k, v in sorted(counts.items(), key=lambda kv: -kv[1])
        ],
        "rows_with_issues": int(df["issues"].apply(lambda x: len(x) > 0).sum()),
        "unknown_types": unknown_types,
        "unknown_statuses": unknown_status,
        "duplicate_headers": dup_headers,
    }


def empty_dataset(reason: str = "업로드된 원본 데이터가 없습니다.") -> Dataset:
    return Dataset(df=pd.DataFrame(), raw_rows=[], headers=[], meta={"file_name": None, "reason": reason},
                   quality={}, empty=True)


# ---------------------------------------------------------------- 저장소


def safe_filename(name: str) -> str:
    base = Path(name).name
    stem = re.sub(r"[^0-9A-Za-z가-힣._-]+", "_", Path(base).stem)[:60].strip("._") or "upload"
    return stem + ".xlsx"


class DataStore:
    """현재 데이터셋 보관. 조회는 참조 하나를 읽고, 적용은 잠금 안에서 참조를 교체한다."""

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.raw_dir = self.data_dir / "raw"
        self.staging_dir = self.data_dir / "staging"
        self.pointer = self.data_dir / "current.json"
        for d in (self.raw_dir, self.staging_dir):
            d.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._dataset: Dataset = empty_dataset()

    # -- 조회
    def get(self) -> Dataset:
        return self._dataset

    # -- 시작 시 로드
    def load_initial(self, default_file: str = "") -> None:
        try:
            if self.pointer.exists():
                info = json.loads(self.pointer.read_text(encoding="utf-8"))
                p = self.data_dir / info["file"]
                self._dataset = build_dataset(p, info.get("original_name", p.name), info.get("uploaded_at", ""))
                return
            if default_file:
                p = Path(default_file)
                if p.exists():
                    ts = dt.datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                    self._dataset = build_dataset(p, p.name, ts + " (DEFAULT_DATA_FILE)")
                    return
                log.warning("DEFAULT_DATA_FILE not found")
        except Exception as e:
            log.exception("initial load failed: %s", type(e).__name__)
            self._dataset = empty_dataset(f"저장된 원본을 읽지 못했습니다: {e}")

    # -- 1단계: 검증(staging)
    def stage(self, fileobj, original_name: str) -> dict:
        t0 = time.perf_counter()
        token = uuid.uuid4().hex
        tmp = self.staging_dir / f"{token}.xlsx"
        if hasattr(fileobj, "save"):
            fileobj.save(str(tmp))
        else:
            with tmp.open("wb") as out:
                shutil.copyfileobj(fileobj, out)
        try:
            validate_file_basic(tmp, original_name)
            ds = build_dataset(tmp, original_name, "검증 중")
        except LoadError as e:
            tmp.unlink(missing_ok=True)
            log.warning("upload validation failed: %s (%.3fs)", str(e)[:200], time.perf_counter() - t0)
            raise
        except Exception as e:
            tmp.unlink(missing_ok=True)
            log.exception("upload validation error")
            raise LoadError(f"파일을 처리하는 중 오류가 발생했습니다: {type(e).__name__}") from e
        (self.staging_dir / f"{token}.json").write_text(
            json.dumps({"original_name": original_name, "staged_at": time.time()}, ensure_ascii=False),
            encoding="utf-8",
        )
        log.info("upload staged: rows=%d seconds=%.3f", ds.meta["row_count"], time.perf_counter() - t0)
        self._cleanup_staging()
        return {"token": token, "meta": ds.meta, "quality": ds.quality}

    # -- 2단계: 적용
    def apply(self, token: str) -> Dataset:
        if not re.fullmatch(r"[0-9a-f]{32}", token or ""):
            raise LoadError("잘못된 업로드 토큰입니다.")
        tmp = self.staging_dir / f"{token}.xlsx"
        info_p = self.staging_dir / f"{token}.json"
        if not tmp.exists() or not info_p.exists():
            raise LoadError("검증된 업로드 파일을 찾을 수 없습니다(만료 또는 이미 적용). 다시 업로드하세요.")
        info = json.loads(info_p.read_text(encoding="utf-8"))
        now = dt.datetime.now()
        dest_name = now.strftime("%Y%m%d_%H%M%S_") + safe_filename(info["original_name"])
        dest = self.raw_dir / dest_name
        with self._lock:
            t0 = time.perf_counter()
            ds = build_dataset(tmp, info["original_name"], now.strftime("%Y-%m-%d %H:%M:%S"))  # 실패 시 기존 유지
            shutil.move(str(tmp), dest)
            info_p.unlink(missing_ok=True)
            ptr_tmp = self.pointer.with_suffix(".json.tmp")
            ptr_tmp.write_text(json.dumps({
                "file": f"raw/{dest_name}", "original_name": info["original_name"],
                "uploaded_at": ds.meta["uploaded_at"],
            }, ensure_ascii=False), encoding="utf-8")
            os.replace(ptr_tmp, self.pointer)
            self._dataset = ds  # 원자적 참조 교체
            log.info("upload applied: rows=%d seconds=%.3f", ds.meta["row_count"], time.perf_counter() - t0)
        return ds

    def _cleanup_staging(self, max_age_sec: int = 6 * 3600) -> None:
        now = time.time()
        for p in self.staging_dir.glob("*"):
            try:
                if now - p.stat().st_mtime > max_age_sec:
                    p.unlink()
            except OSError:
                pass
