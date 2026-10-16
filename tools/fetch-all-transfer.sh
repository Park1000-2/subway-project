#!/bin/sh
# 국가철도공단 운영기관별 환승정보 CSV 일괄 다운로드 (수도권)
# 공공데이터포털 파일 다운로드는 로그인이 필요 없습니다.
set -e
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
OUT="${1:-data/krn}"
mkdir -p "$OUT"
# 데이터셋ID:파일명
SETS="15041051:수도권1호선 15041052:수도권2호선 15041053:수도권3호선 15041054:수도권4호선 \
15041055:수도권5호선 15041056:수도권6호선 15041057:수도권7호선 15041058:수도권8호선 \
15041059:수도권9호선 15041060:수인분당선 15041061:경춘선 15041062:수인선 15041064:경의중앙선 \
15041066:경강선 15041068:우이신설 15041069:의정부경전철 15041070:인천1호선 15041071:인천2호선 \
15041072:신분당선 15041075:에버라인 15041085:코레일 15041087:서울교통공사 15041088:서울9호선 \
15041089:인천국제공항철도 15041090:공항철도 15041093:인천지하철"
for S in $SETS; do
  ID="${S%%:*}"; NAME="${S##*:}"
  PAGE="https://www.data.go.kr/data/$ID/fileData.do"
  LINK=$(curl -sL -A "$UA" "$PAGE" | grep -oE 'fileDownload\.do\?atchFileId=[A-Za-z0-9_]+&fileDetailSn=[0-9]+[^"]*' | head -1)
  if [ -z "$LINK" ]; then echo "  [건너뜀] $NAME ($ID): 다운로드 링크 없음"; continue; fi
  curl -sL -A "$UA" -e "$PAGE" "https://www.data.go.kr/cmm/cmm/$LINK" -o "$OUT/$NAME.csv"
  echo "  $NAME.csv ($(wc -c < "$OUT/$NAME.csv" | tr -d ' ') bytes)"
done
