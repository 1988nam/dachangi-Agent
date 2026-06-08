/**
 * 다챙이 설정 예시. 실제 키는 앱의 ⚙️ 설정(모달)에서 입력하면 localStorage에 저장됩니다.
 * (이 파일은 참고용 템플릿. 로컬에서 js/config.js로 복사해 쓰는 것도 가능)
 */
const DACHANGI_CONFIG = {
  CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
  API_KEY: 'YOUR_GOOGLE_API_KEY',
  GEMINI_API_KEY: 'YOUR_GEMINI_API_KEY',
  GEMINI_MODEL: 'gemini-2.5-flash',
  MAIN_PHOTO_FOLDER_ID: 'YOUR_MAIN_PHOTO_FOLDER_ID', // 안에 yyyy-MM 월별 폴더가 있는 폴더
  SCOPES: 'https://www.googleapis.com/auth/drive.readonly',
  DIARY_PROMPT: '너는 사용자의 하루를 따뜻하고 담백하게 기록하는 일기 작가야. 첨부 사진({{DATE}})을 종합해 그날의 일기를 한국어로 자연스럽게 써줘.',
};
