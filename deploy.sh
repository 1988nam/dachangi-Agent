#!/usr/bin/env bash
#
# 아이별 배포 — 같은 소스, 아이별 브랜드/도메인.
#   ./deploy.sh            # 다챙이(기본) 배포
#   ./deploy.sh dachangi   # 다챙이 배포
#   ./deploy.sh siu        # 시우챙이 배포
#
# 동작: .deploy/ 에 소스를 복사 → brand/<child>/ 를 덮어씀 → Cloudflare Pages 배포.
#   작업 트리(git 추적 파일)는 건드리지 않는다. .deploy/ 는 .gitignore 대상.
#
set -euo pipefail

CHILD="${1:-dachangi}"
case "$CHILD" in
  dachangi)          PROJECT="dachangi" ;;
  siu|siuchangi)     CHILD="siu"; PROJECT="siuchangi" ;;
  *) echo "❌ 알 수 없는 아이: '$CHILD' (사용법: ./deploy.sh [dachangi|siu])"; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/.deploy"

echo "▶ 대상: $CHILD  →  Cloudflare Pages 프로젝트 '$PROJECT'"

rm -rf "$OUT"
mkdir -p "$OUT"

# 공통 소스 복사(.git / .deploy / brand / node_modules 는 제외)
cp -R "$ROOT/index.html" "$ROOT/style.css" "$ROOT/sw.js" \
      "$ROOT/manifest.webmanifest" "$ROOT/js" "$ROOT/icons" "$ROOT/functions" "$OUT/"

# 아이별 브랜드 오버레이(있으면 덮어씀 — dachangi 는 기본값이라 오버레이 불필요)
BRAND_DIR="$ROOT/brand/$CHILD"
if [ -d "$BRAND_DIR" ]; then
  [ -f "$BRAND_DIR/brand.js" ]           && cp "$BRAND_DIR/brand.js"           "$OUT/js/brand.js"
  [ -f "$BRAND_DIR/manifest.webmanifest" ] && cp "$BRAND_DIR/manifest.webmanifest" "$OUT/manifest.webmanifest"
  [ -d "$BRAND_DIR/icons" ]              && cp "$BRAND_DIR/icons/"* "$OUT/icons/" 2>/dev/null || true
  echo "  · 브랜드 오버레이 적용: brand/$CHILD"
else
  echo "  · 기본 브랜드(다챙이) 사용"
fi

echo "▶ 배포 시작..."
# 최초 배포면 Pages 프로젝트가 없어 대화형 프롬프트가 뜰 수 있으므로 미리 생성(이미 있으면 무시)
npx wrangler pages project create "$PROJECT" --production-branch main >/dev/null 2>&1 || true
( cd "$OUT" && npx wrangler pages deploy . --project-name "$PROJECT" --branch main )

echo "✅ '$PROJECT' 배포 완료."
echo "   새 도메인이라면 구글 OAuth 클라이언트의 '승인된 자바스크립트 원본'에 도메인을 추가해야 로그인됩니다."
