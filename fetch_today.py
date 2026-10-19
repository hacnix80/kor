"""KRX 정보데이터시스템 '전종목 시세'(MDCSTAT01501)를 장 마감 뒤 받아 data/YYYY/krx-YYYYMMDD.parquet 로 저장한다.

- 열 구성은 FinanceData/marcap 과 같다 (Code, Name, Close, ..., Rank, Date). 그래서 두 데이터를 이어 붙여 쓸 수 있다.
- 오늘 데이터는 실행할 때마다 다시 받아 덮어쓴다(16시대 1차, 18시대 최종).
- 최근 BACKFILL_DAYS 일 중 빠졌거나 최종값이 아닌 날은 함께 받는다.
- 휴장일은 data/index.json 의 holidays 에 기록해 다시 묻지 않는다.

환경변수
  KRX_ID, KRX_PW   KRX 정보데이터시스템(data.krx.co.kr) 계정. GitHub Actions secrets 로만 넣는다.
  DATES            (선택) 받을 날짜 YYYYMMDD, 쉼표 구분. 비우면 자동.
  BACKFILL_DAYS    (선택) 자동 모드에서 거슬러 볼 날 수. 기본 10.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import requests

KST = timezone(timedelta(hours=9))
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')
LOGIN_PAGE = 'https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001.cmd'
LOGIN_JSP = 'https://data.krx.co.kr/contents/MDC/COMS/client/view/login.jsp?site=mdc'
LOGIN_URL = 'https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001D1.cmd'
DATA_URL = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd'
REFERER = 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201'

COLS = {'ISU_SRT_CD': 'Code', 'ISU_ABBRV': 'Name', 'TDD_CLSPRC': 'Close', 'SECT_TP_NM': 'Dept',
        'FLUC_TP_CD': 'ChangeCode', 'CMPPREVDD_PRC': 'Changes', 'FLUC_RT': 'ChangesRatio',
        'ACC_TRDVOL': 'Volume', 'ACC_TRDVAL': 'Amount', 'TDD_OPNPRC': 'Open', 'TDD_HGPRC': 'High',
        'TDD_LWPRC': 'Low', 'MKTCAP': 'Marcap', 'LIST_SHRS': 'Stocks', 'MKT_NM': 'Market',
        'MKT_ID': 'MarketId'}
FLOAT_COLS = ['Close', 'Changes', 'ChangesRatio', 'Volume', 'Amount', 'Open', 'High', 'Low', 'Marcap']
STR_COLS = ['Code', 'Name', 'Dept', 'ChangeCode', 'Market', 'MarketId']

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
INDEX = os.path.join(DATA_DIR, 'index.json')
CLOSE_MIN = 15 * 60 + 40   # 15:40 이전이면 오늘 장이 아직 안 끝난 것으로 본다
FINAL_MIN = 18 * 60 + 10   # 18:10(시간외 단일가 종료) 이후에 받은 값을 최종값으로 본다

VERIFY = True


def log(*a):
    print(*a, flush=True)


def gh_note(level, msg):
    """GitHub Actions 주석으로도 남긴다(실행 화면 요약과 API에서 바로 보인다)."""
    if os.environ.get('GITHUB_ACTIONS'):
        print(f'::{level}::' + str(msg).replace('\r', ' ').replace('\n', ' ')[:900], flush=True)


def fail(msg):
    log(msg)
    gh_note('error', msg)
    sys.exit(1)


def req(s, method, url, **kw):
    """TLS 검증을 먼저 시도하고, KRX 인증서 문제로 실패할 때만 검증 없이 다시 시도한다."""
    global VERIFY
    kw.setdefault('timeout', 30)
    try:
        return s.request(method, url, verify=VERIFY, **kw)
    except requests.exceptions.SSLError:
        if not VERIFY:
            raise
        log('경고: KRX TLS 인증서 검증 실패 -> 검증 없이 재시도')
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        VERIFY = False
        return s.request(method, url, verify=False, **kw)


def login():
    kid, kpw = os.environ.get('KRX_ID', ''), os.environ.get('KRX_PW', '')
    if not kid or not kpw:
        fail('KRX_ID / KRX_PW secret 이 없습니다. 저장소 Settings > Secrets and variables > Actions 에 추가하세요.')
    s = requests.Session()
    s.headers.update({'User-Agent': UA})
    req(s, 'GET', LOGIN_PAGE)
    req(s, 'GET', LOGIN_JSP, headers={'Referer': LOGIN_PAGE})
    payload = {'mbrNm': '', 'telNo': '', 'di': '', 'certType': '', 'mbrId': kid, 'pw': kpw}

    def post():
        r = req(s, 'POST', LOGIN_URL, data=payload, headers={'Referer': LOGIN_PAGE})
        try:
            return r.json()
        except ValueError:
            fail(f'KRX 로그인 응답을 읽지 못했습니다 (HTTP {r.status_code}): {r.text[:200]}')

    j = post()
    code = j.get('_error_code', '')
    if code == 'CD011':          # 다른 곳에서 로그인 중 -> 그 세션을 끊고 로그인
        payload['skipDup'] = 'Y'
        j = post()
        code = j.get('_error_code', '')
    if code == 'CD010':
        fail('KRX 비밀번호 변경이 필요합니다. data.krx.co.kr 에서 비밀번호를 바꾼 뒤 KRX_PW secret 도 바꿔 주세요.')
    if code != 'CD001':
        fail(f'KRX 로그인 실패 ({code}): {j.get("_error_message", "")}')
    log('KRX 로그인 성공')
    s.headers.update({'Referer': REFERER, 'X-Requested-With': 'XMLHttpRequest',
                      'Accept': 'application/json, text/javascript, */*; q=0.01'})
    return s


def fetch(s, ymd):
    """해당 날짜 전종목 시세. 거래가 없는 날(휴장)이면 None."""
    data = {'bld': 'dbms/MDC/STAT/standard/MDCSTAT01501', 'locale': 'ko_KR', 'mktId': 'ALL',
            'trdDd': ymd, 'share': '1', 'money': '1', 'csvxls_isNo': 'false'}
    r = req(s, 'POST', DATA_URL, data=data)
    if r.status_code != 200:
        fail(f'{ymd}: KRX 응답 HTTP {r.status_code}: {r.text[:300]}')
    try:
        j = r.json()
    except ValueError:
        fail(f'{ymd}: KRX 응답이 JSON 이 아닙니다(로그인 만료?): {r.text[:300]}')
    rows = j.get('OutBlock_1') or []
    if not rows:
        return None
    df = pd.DataFrame(rows)
    miss = [c for c in COLS if c not in df.columns]
    if miss:
        fail(f'{ymd}: KRX 응답에 열이 없습니다: {miss}')
    df = df[list(COLS)].rename(columns=COLS)
    for c in FLOAT_COLS:
        df[c] = pd.to_numeric(df[c].astype(str).str.replace(',', ''), errors='coerce').astype('float64')
    df['Stocks'] = pd.to_numeric(df['Stocks'].astype(str).str.replace(',', ''), errors='coerce')
    df = df.dropna(subset=['Volume', 'Close'])
    if df.empty or df['Volume'].sum() == 0:
        return None
    df['Stocks'] = df['Stocks'].fillna(0).astype('int64')
    for c in STR_COLS:
        df[c] = df[c].astype(str).replace({'': None, '-': None, 'nan': None})
    df = df.sort_values('Marcap', ascending=False).reset_index(drop=True)
    df['Rank'] = np.arange(1, len(df) + 1, dtype='int64')
    df['Date'] = pd.Timestamp(datetime.strptime(ymd, '%Y%m%d'))
    return df


def path_of(ymd):
    return os.path.join(DATA_DIR, ymd[:4], f'krx-{ymd}.parquet')


def same_prices(a, b):
    """두 날 데이터가 사실상 같은지(KRX 가 아직 갱신 전이거나 휴장일에 직전 거래일 값을 돌려준 경우)."""
    k = ['Code', 'Close', 'Volume']
    a2 = a[k].sort_values('Code').reset_index(drop=True)
    b2 = b[k].sort_values('Code').reset_index(drop=True)
    return a2.equals(b2)


def prev_stored(ymd, idx):
    days = sorted(d for d in idx['days'] if d < ymd)
    if not days:
        return None
    p = path_of(days[-1])
    return pd.read_parquet(p) if os.path.exists(p) else None


def main():
    now = datetime.now(KST)
    now_min = now.hour * 60 + now.minute
    today = now.strftime('%Y%m%d')
    idx = {'days': {}, 'holidays': []}
    if os.path.exists(INDEX):
        with open(INDEX, encoding='utf-8') as f:
            idx.update(json.load(f))

    if os.environ.get('DATES', '').strip():
        targets = [d.strip() for d in os.environ['DATES'].split(',') if d.strip()]
    else:
        back = int(os.environ.get('BACKFILL_DAYS', '10') or 10)
        targets = []
        for i in range(back, -1, -1):
            dt = now - timedelta(days=i)
            ymd = dt.strftime('%Y%m%d')
            if dt.weekday() >= 5 or ymd in idx['holidays']:
                continue
            if ymd == today:
                if now_min >= CLOSE_MIN:
                    targets.append(ymd)
                continue
            meta = idx['days'].get(ymd)
            if meta is None or not meta.get('final'):
                targets.append(ymd)
    log('대상 날짜:', targets or '없음')
    if not targets:
        return

    s = login()
    for ymd in targets:
        is_today = ymd == today
        final = (not is_today) or now_min >= FINAL_MIN
        df = fetch(s, ymd)
        prev = prev_stored(ymd, idx)
        if df is not None and prev is not None and same_prices(df, prev):
            df = None   # 직전 거래일과 똑같다 -> 아직 갱신 전이거나 휴장
        if df is None:
            if final:
                log(f'{ymd}: 거래 데이터 없음 -> 휴장일로 기록')
                if ymd not in idx['holidays']:
                    idx['holidays'].append(ymd)
                    idx['holidays'].sort()
            else:
                log(f'{ymd}: 아직 갱신 전 -> 다음 실행에서 다시 받음')
            continue
        p = path_of(ymd)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        old = pd.read_parquet(p) if os.path.exists(p) else None
        meta = idx['days'].get(ymd, {})
        changed = old is None or not old.reset_index(drop=True)[FLOAT_COLS].equals(df[FLOAT_COLS]) \
            or len(old) != len(df)
        if changed:
            df.to_parquet(p, index=False, compression='snappy')
        if changed or meta.get('final') != final:
            idx['days'][ymd] = {'rows': int(len(df)), 'final': bool(final),
                                'fetched_at': now.isoformat(timespec='seconds')}
        up = int((df['ChangesRatio'] >= 29.5).sum())
        tm = int((df['Volume'] >= 10_000_000).sum())
        msg = f'{ymd}: {len(df)}종목 저장{"" if changed else "(변화 없음)"} · 상한가 {up} · 천만주 {tm} · 최종값 {final}'
        log(msg)
        gh_note('notice', msg)

    idx['latest'] = max(idx['days']) if idx['days'] else None
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(INDEX, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, indent=1, sort_keys=True)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # 예상 못 한 오류도 주석으로 남긴다
        fail(f'예상 못 한 오류 {type(e).__name__}: {e}')
