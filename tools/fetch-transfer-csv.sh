#!/bin/sh
# 서울교통공사 서울 도시철도 환승정보 CSV 내려받기 (공공데이터포털, 로그인 불필요)
# 파일 ID가 바뀌면 https://www.data.go.kr/data/15098252/fileData.do 에서 다시 확인하세요.
set -e
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
PAGE="https://www.data.go.kr/data/15098252/fileData.do"
LINK=$(curl -sL -A "$UA" "$PAGE" | grep -oE 'fileDownload\.do\?atchFileId=[A-Za-z0-9_]+&fileDetailSn=[0-9]+[^"]*' | head -1)
[ -n "$LINK" ] || { echo "다운로드 링크를 찾지 못했습니다. 페이지 구조가 바뀌었는지 확인하세요."; exit 1; }
curl -sL -A "$UA" -e "$PAGE" "https://www.data.go.kr/cmm/cmm/$LINK" -o data/transfer-info.csv
echo "data/transfer-info.csv 저장 완료"
