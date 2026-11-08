"""공공영업 통합 대시보드 설정 — 업무 기준과 실행 환경을 한 곳에서 관리한다.

환경변수(.env)로 바꿀 수 있는 값과 코드 상수(원본 열 이름·상태값 정의)를 함께 둔다.
업무 기준값은 화면의 '계산 기준' 패널에 그대로 노출된다.
"""
from __future__ import annotations

import os
from pathlib import Path

try:  # python-dotenv 가 있으면 .env 를 읽는다(없어도 동작)
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:  # pragma: no cover
    pass

BASE_DIR = Path(__file__).resolve().parent


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v.strip() == "" else v.strip()


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(_env(name, str(default))))
    except ValueError:
        return default


def normalize_prefix(p: str | None) -> str:
    """URL_PREFIX 정규화: '' 또는 '/xxx' (끝 슬래시 제거, 중복 슬래시 제거)."""
    if not p:
        return ""
    parts = [s for s in p.strip().split("/") if s]
    return "/" + "/".join(parts) if parts else ""


# ---------------------------------------------------------------- 실행 환경
HOST = _env("HOST", "127.0.0.1")
PORT = _env_int("PORT", 8000)
URL_PREFIX = normalize_prefix(_env("URL_PREFIX", ""))
DATA_DIR = Path(_env("DATA_DIR", str(BASE_DIR / "data"))).resolve()
LOG_DIR = Path(_env("LOG_DIR", str(BASE_DIR / "logs"))).resolve()
DEBUG = _env("FLASK_DEBUG", "0") in ("1", "true", "True")
MAX_UPLOAD_MB = _env_float("MAX_UPLOAD_MB", 20)
# 업로드·적용 권한 분리용 토큰(미설정이면 업로드가 조회 사용자에게도 열려 있음 → 화면에 경고)
ADMIN_TOKEN = _env("ADMIN_TOKEN", "")
# 시작 시 적용할 기본 원본 파일(선택). 업로드 이력이 있으면 업로드본이 우선.
DEFAULT_DATA_FILE = _env("DEFAULT_DATA_FILE", "")
# 기준일 고정(선택, YYYY-MM-DD). 비우면 서버 오늘 날짜.
BASE_DATE = _env("BASE_DATE", "")
WAITRESS_THREADS = _env_int("WAITRESS_THREADS", 8)

# ---------------------------------------------------------------- 금액 단위
UNIT_FACTORS_TO_WON = {"원": 1, "천원": 1_000, "백만원": 1_000_000, "억원": 100_000_000}
# 원본 금액 단위. 유선Funnel 원본은 백만원으로 확인됨(업무 확인 완료).
# 'unknown' 으로 두면 '원본 단위·확인 필요'(변환 불가) 상태로 표시
SOURCE_UNIT = _env("SOURCE_UNIT", "백만원")
if SOURCE_UNIT not in UNIT_FACTORS_TO_WON:
    SOURCE_UNIT = "unknown"

# ---------------------------------------------------------------- 업무 기준(화면에서 조회 시 변경 가능)
BUSINESS_DEFAULTS = {
    # 최근영업활동내역 저장일시가 기준일로부터 N일 초과 경과하면 '미갱신'
    "stale_days": _env_int("STALE_DAYS", 30),
    # 대형 사업(A/C 진행 중): 계약기간매출 ≥ 값 (원본 단위=백만원, 1000 = 10억원)
    "large_contract_amount": _env_float("LARGE_CONTRACT_AMOUNT", 1000),
    # 대형 재계약(R 진행 중): 기존 월매출 ≥ 값 (원본 단위=백만원, 30 = 월 3천만원)
    "large_renewal_monthly": _env_float("LARGE_RENEWAL_MONTHLY", 30),
    # 예정 임박: 기준월 포함 N개월(1 → 이번 달·다음 달)
    "imminent_months": _env_int("IMMINENT_MONTHS", 1),
    # 높은 입력 가능성: 수주(재계약)가능성 ≥ % (Pre Sales 확인 대상)
    "high_probability": _env_float("HIGH_PROBABILITY", 70),
    # 장기 미갱신(강): 저장일시가 N일 초과 경과한 진행 중 건(높음 등급)
    "stale_long_days": _env_int("STALE_LONG_DAYS", 90),
    # 장기 체류: 변경이력 최초 기록일이 N일 초과 경과한 진행 중 건
    "long_stay_days": _env_int("LONG_STAY_DAYS", 365),
    # 재계약 임박·저확률: 수주(재계약)가능성 ≤ % 인 임박 R
    "renewal_low_prob": _env_float("RENEWAL_LOW_PROB", 30),
    # AM 성과 점검: 분모가 N건 미만이면 비율 대신 '표본 부족(건수)'
    "min_sample": _env_int("MIN_SAMPLE", 10),
}

# ---------------------------------------------------------------- 원본 열 정의(헤더 이름으로 연결)
SHEET_NAME_PREFERRED = "유선Funnel조회"

COL = {
    "customer": "고객사",
    "win_ym": "수주년월",
    "monthly": "월매출합계",
    "status": "현재상황",
    "activity": "최근영업활동내용",
    "team": "팀",
    "module": "모듈",
    "am": "AM",
    "acr_type": "ACR유형",
    "culti_detail": "Culti 상세",
    "ret_detail": "Ret.상세",
    "term": "계약기간(월)",
    "rev_ym": "매출발생년월",
    "funnel_id": "Funnel번호",
    "hq": "본부",
    "annual": "연매출",
    "contract_amt": "계약기간매출",
    "prob": "수주(재계약)가능성",
    "prev_monthly": "기존매출",
    "new_monthly": "변경매출",
    "updated_at": "최근영업활동내역 저장일시",
    "confirmer": "확정자",
    "confirmed_at": "확정일자",
    "strategy_reg": "재계약전략 등록여부",
    "bid_method": "입찰방식",
    "qualification": "참가자격",
    "winloss_reason": "승패사유",
    "drop_reason": "Drop세부사유",
    "churn_reason": "해지사유",
    "churn_type": "해지유형",
    "bid_no": "입찰공고번호",
    "bid_name": "입찰공고명",
    "expected_amt": "수주예상금액",
    "possible_rev": "수주가능매출",
    "prob_history": "수주가능성 변경이력",
    "rmr_excl": "RMR제외",
    "midlarge_excl": "중대형퍼널제외",
}
PRODUCT_SLOTS = 5  # Biz1~5 / 상품1~5 / 월매출1~5

# 상품 카테고리. 원본 상품명 기준: 전용회선 = 국내전용 + 국제전용(원본 표기). '국외전용' 표기도 같은 묶음으로 인정
LEASED_PRODUCTS = [x.strip() for x in _env("LEASED_PRODUCTS", "국내전용,국제전용,국외전용").split(",") if x.strip()]
PRODUCT_GROUPS = {
    "all": "상품전체(모든 상품)",
    "leased": "전용회선(국내전용+국제전용)",
    "non_leased": "전용회선외(나머지 상품)",
}
NO_PRODUCT_MATCH = "\u0000선택 상품 없음"

# 없으면 적용 불가(업로드 거부)
REQUIRED_COLUMNS = [
    "고객사", "수주년월", "월매출합계", "현재상황", "팀", "AM", "ACR유형",
    "계약기간(월)", "매출발생년월", "Funnel번호", "본부", "계약기간매출", "기존매출", "변경매출",
]

TARGET_HQ = _env("TARGET_HQ", "공공고객담당")

# ACR 유형 매핑(원본 → 코드)
ACR_TYPE_MAP = {
    "acq.": "A", "acq": "A", "a": "A", "acqui": "A",
    "cul.": "C", "cul": "C", "c": "C", "culti": "C",
    "ret.": "R", "ret": "R", "r": "R",
}
ACR_TYPE_LABEL = {"A": "A (Acq.)", "C": "C (Cul.)", "R": "R (Ret.)"}

KNOWN_STATUSES = ["Pre Sales", "제안완료", "Win", "재계약완료", "해지확정", "Drop", "Lose"]
IN_PROGRESS = {"Pre Sales", "제안완료"}

# ACR 확정 집계 조건: 유형별 인정 상태
ACR_CONFIRMED_STATUS = {"A": "Win", "C": "Win", "R": "재계약완료"}

UNASSIGNED_ORG = "조직 미입력"

# 기본 조회기간: 시작월 = 기준일 연도 1월(DEFAULT_YM_FROM 지정 시 그 값), 종료월 = DEFAULT_YM_TO(YYYY-MM)
DEFAULT_YM_FROM = _env("DEFAULT_YM_FROM", "")
DEFAULT_YM_TO = _env("DEFAULT_YM_TO", "2027-12")
