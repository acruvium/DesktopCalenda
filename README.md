# Desktop Calendar Dock

Google Calendar와 Google Tasks를 데스크톱에서 함께 확인하고 관리할 수 있는 Tauri 기반 앱입니다.

## 개발 정보

- 앱 이름: `Desk Calendar Dock`
- 현재 버전: `1.1.3`
- 프런트엔드: `React 18`, `TypeScript`, `Vite`
- 캘린더 UI: `FullCalendar`
- 데스크톱 런타임: `Tauri 2`
- 백엔드: `Rust`
- 대상 환경: `Windows`

## 주요 기능

- Google Calendar 일정 조회, 생성, 수정, 삭제
- Google Tasks 조회, 생성, 수정, 삭제
- 일정 드래그 이동 및 시간 변경
- 할일 완료/미완료 전환
- 위치 버튼으로 Google Maps 열기
- 위치가 없을 때 기본 좌표 `37.478234, 126.951572`로 열기
- Google Maps 기본 이동 모드 `transit`
- 로그인 여부와 관계없이 좌측 하단 버전 배지 표시

## 실행 방법

### 의존성 설치

```powershell
npm install
```

### 프런트엔드 빌드

```powershell
npm run build
```

### Tauri 개발 실행

```powershell
npm run tauri dev
```

### Windows 실행 파일/설치 파일 빌드

```powershell
npm run tauri build
```
