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
  DIARY_PROMPT: '너는 사용자 본인이 되어 그날 하루를 직접 쓰는 일기야. 첨부 사진({{DATE}})을 시간 흐름대로 엮어, 1인칭 반말 기록체로 담백하게 적어줘. 확인되는 사람·장소·숫자는 구체적으로, 모르는 건 단정하지 말고, 마지막은 짧은 감상 한 줄로 맺어.',
};
