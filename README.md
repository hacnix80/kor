# kor — 상천정리용 KRX 당일 시세

평일 장 마감 뒤 GitHub Actions가 KRX 정보데이터시스템의 '전종목 시세'를 받아 `data/` 에 커밋합니다.
Claude의 '상천 노트 자동 정리' 작업이 이 데이터를 읽어 그날 상한가·천만주를 정리합니다.

- 실행 시각(KST): 15:52 · 16:47 · 18:23 (18:23 값이 최종값)
- 저장: `data/YYYY/krx-YYYYMMDD.parquet` (열 구성은 FinanceData/marcap 과 같음), `data/index.json`
- 필요한 secret: `KRX_ID`, `KRX_PW` (data.krx.co.kr 계정)
- 수동 실행: Actions → "KRX 당일 시세 수집 (상천정리)" → Run workflow (날짜를 비우면 오늘 + 최근 빠진 날)

KRX가 비밀번호 변경을 요구하면 실행이 실패하고 GitHub이 메일로 알려 줍니다.
그때 data.krx.co.kr 에서 비밀번호를 바꾸고 `KRX_PW` secret 도 같이 바꾸면 됩니다.
