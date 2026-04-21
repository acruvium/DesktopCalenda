# Desk Calendar Dock 명세서

## 1. 목적

- Google Calendar와 Google Tasks를 데스크톱 앱에서 통합 조회하고 관리한다.
- 일정과 할일의 생성, 수정, 삭제, 이동, 완료 처리를 지원한다.
- Google 계정 인증과 세션 복구를 지원한다.

## 2. 기술 스택

- Frontend: React + TypeScript + Vite
- Desktop Runtime: Tauri 2
- Backend: Rust

## 3. 인증 및 설정

- OAuth 인증 방식: 브라우저 인증 + loopback callback (`127.0.0.1`)
- 설정 파일: `src/config.ts`
- 주요 설정값
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
  - `GOOGLE_ALLOW_INSECURE_TLS`

## 4. Google 연동 기능

### 4.1 Calendar

- Calendar 목록 조회
- Calendar 이름, 선택 상태, 색상 반영
- 이벤트 조회, 생성, 수정, 삭제
- 이벤트 드래그 이동 및 리사이즈

### 4.2 Tasks

- Task list 조회
- Task 조회
- Task 생성, 수정, 삭제
- Task 완료/미완료 전환
- Task due 날짜 이동

### 4.3 부분 실패 허용

- Tasks API 호출이 실패해도 Calendar 데이터 로드는 계속 진행한다.
- 일부 API만 실패하면 가능한 데이터만 반영하고 상태 메시지로 안내한다.

## 5. 등록/수정 모달

### 5.1 Event 모달

- 필드
  - Title
  - Start / End
  - Calendar 선택
  - Location
  - Guests
  - Description
- 기존 이벤트 수정 및 삭제를 지원한다.
- 캘린더와 일정 목록에서 더블클릭으로 편집 모달에 진입할 수 있다.
- 편집 모달에서 `Duplicate` 버튼으로 현재 입력 상태를 기준으로 새 이벤트를 복제할 수 있다.
- `Location` 입력 오른쪽의 지도 버튼으로 Google Maps를 연다.
- 위치 값이 있으면 입력된 주소 또는 위경도를 목적지로 매번 강제로 연다.
- 위치 값이 없으면 기본 좌표 `37.478234, 126.951572`를 목적지로 강제로 연다.
- 기본 지도 이동 모드는 `transit`를 사용한다.
- 지도는 `zoom 19` 기준, 약 `1:500` 수준에 가깝게 열리도록 맞춘다.
- 지도 URL은 브라우저가 이전 지도 상태를 재사용하지 않도록 매번 새 요청으로 연다.
- Google Maps Platform API는 사용하지 않고 URL 기반으로 연다.

### 5.2 Task 모달

- 필드
  - Title
  - Due Date
  - Task list 선택
  - Notes
- 기존 할일 수정 및 삭제를 지원한다.
- 할일 목록, 예정 작업 목록, 캘린더의 task 항목에서 더블클릭으로 편집 모달에 진입할 수 있다.
- 상세 카드 우측 상단의 `X` 버튼으로 상세 보기를 닫을 수 있다.
- 위치 정보가 있는 task-like 항목은 상세 카드에서 지도 버튼으로 Google Maps를 열 수 있다.

## 6. UI 동작

### 6.1 좌측 패널

- 미니 캘린더를 제공한다.
- 메인 캘린더와 선택 날짜를 KST 기준으로 동기화한다.
- Google Account 영역에서 `Sign In`, `Refresh`, `Sign Out`을 제공한다.
- `My calendars` 목록에서 캘린더 표시 여부와 색상 변경이 가능하다.
- 앱 시작 전후와 로그인 전후 관계없이 좌측 하단에 현재 앱 버전을 항상 표시한다.

### 6.2 메인 캘린더

- 상단 네비게이션: `Today`, `Prev`, `Next`, `Month`, `Week`, `Day`
- 날짜 클릭 시 해당 날짜를 선택하고 새 일정 입력으로 진입할 수 있다.
- 일정/작업 선택 시 상세 패널 또는 편집 모달로 진입한다.
- 일정 드래그 이동을 지원한다.

### 6.3 하단 카드: 예정 작업 및 일정

- 카드 제목: `예정 작업 및 일정`
- 일정과 작업을 하나의 목록으로 통합 표시한다.
- 전체 목록은 날짜 오름차순으로 정렬한다.
- 지난 일정은 목록에서 제외한다.
- 완료된 작업은 목록에서 제외한다.
- 오늘 이전의 미완료 작업은 구분된 강조 스타일로 표시한다.

## 7. 색상 정책

- 캘린더 색상 우선순위
  1. 사용자 override 색상
  2. Google Calendar List `backgroundColor`
  3. 기본 색상
- 적용 영역
  - 좌측 캘린더 목록
  - 메인 캘린더 이벤트
  - 선택 날짜 상세 목록
  - 하단 `예정 작업 및 일정` 카드

## 8. 동기화 규칙

- 앱 실행 및 로그인 복구 시 Google 데이터를 다시 조회한다.
- 생성, 수정, 삭제, 완료, 이동 결과를 UI에 즉시 반영한다.
- 권한 부족 시 가능한 범위만 반영하고 상태 메시지로 안내한다.

## 9. 권한 요구사항

- Calendar 읽기/쓰기: `https://www.googleapis.com/auth/calendar`
- Tasks 읽기/쓰기: `https://www.googleapis.com/auth/tasks`

## 10. 현재 버전

- 앱 버전: `1.1.3`
- 버전 반영 파일
  - `package.json`
  - `src-tauri/tauri.conf.json`
  - `src-tauri/Cargo.toml`

## 11. 빌드 산출물

- 실행 파일: `E:\Projects\DesktopCalendar\src-tauri\target\release\desk-calendar-dock.exe`
- NSIS 설치 파일: `E:\Projects\DesktopCalendar\src-tauri\target\release\bundle\nsis\Desk Calendar Dock_1.1.3_x64-setup.exe`
- MSI 설치 파일: `E:\Projects\DesktopCalendar\src-tauri\target\release\bundle\msi\Desk Calendar Dock_1.1.3_x64_en-US.msi`
