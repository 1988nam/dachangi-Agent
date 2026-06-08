# 다챙이 (dachangi) — AI 일기 에이전트

구글 드라이브의 사진을 **Gemini가 분석**해 하루 일기를 자동으로 써주는 브라우저 에이전트.
가챙이·투챙이와 동일하게 **백엔드 없이** 브라우저에서 구글 OAuth로 동작하며, Cloudflare Pages 정적 호스팅으로 배포한다.

## 동작 (GAS 일기봇 파이프라인 포팅)
1. 선택한 날짜의 `yyyy-MM` 월별 폴더를 메인 폴더에서 찾음
2. 그날 촬영(EXIF 기준)된 사진만 수집
3. 해상도(70%)+용량(30%) 복합 점수 상위 N장 1차 선별
4. **Gemini Vision**으로 대표 사진 랭킹 → 상위 K장
5. **Gemini**가 상위 사진들로 일기 작성 → 화면에 표시(복사/다운로드)

## 설정 (앱 ⚙️ 설정에서 입력 → localStorage 저장)
- Google **CLIENT_ID / API Key** (OAuth, Drive 읽기)
- **Gemini API Key** + 모델
- **사진 메인 폴더 ID** (안에 `yyyy-MM` 폴더가 있는 폴더)
- 일기 프롬프트(가이드)

권한(SCOPES)은 `drive.readonly`(사진 읽기)만 사용. 일기는 브라우저에 표시되며 저장은 복사/`.txt` 다운로드.

## 배포 (Cloudflare Pages, 정적)
```
npx wrangler pages deploy . --project-name dachangi --branch main
```
새 도메인은 구글 OAuth 클라이언트의 "승인된 자바스크립트 원본"에 추가해야 로그인됨.

## 다음 단계(예정)
- 생성된 일기를 구글 문서/드라이브에 자동 저장(요청 시 documents 스코프 추가)
- 이전 '(완)' 일기 문체 참고 주입, 대표 사진 별도 폴더 보관 등 GAS 고급 기능 이식
