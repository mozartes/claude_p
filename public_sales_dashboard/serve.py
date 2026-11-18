"""운영 실행(waitress). Debug 는 항상 OFF.
사용: python serve.py   (HOST/PORT/URL_PREFIX 등은 .env 또는 환경변수)
"""
import logging

from waitress import serve

import config as C
from app import create_app

if __name__ == "__main__":
    application = create_app()
    logging.getLogger("dashboard.app").info(
        "waitress start host=%s port=%s prefix=%s threads=%s", C.HOST, C.PORT, C.URL_PREFIX or "/", C.WAITRESS_THREADS)
    serve(application, host=C.HOST, port=C.PORT, threads=C.WAITRESS_THREADS)
