import type {
  CalendarEvent,
  CalendarInfo,
  Settings,
  TaskItem,
  TaskListInfo
} from "./types";

const today = new Date();

const shiftDate = (offset: number, hours = 9) => {
  const date = new Date(today);
  date.setDate(date.getDate() + offset);
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
};

export const initialCalendars: CalendarInfo[] = [
  { id: "primary", name: "내 캘린더", color: "#d96b39" },
  { id: "team", name: "프로젝트", color: "#2f6c5e" }
];

export const initialTaskLists: TaskListInfo[] = [
  { id: "personal", name: "개인 할 일", color: "#d96b39" },
  { id: "work", name: "업무 체크리스트", color: "#2754c5" }
];

export const initialEvents: CalendarEvent[] = [
  {
    id: "event-1",
    calendarId: "primary",
    title: "주간 회고",
    start: shiftDate(0, 10),
    end: shiftDate(0, 11),
    allDay: false,
    description: "지난주 작업 정리와 이번주 우선순위 점검",
    location: "온라인 미팅",
    color: "#d96b39"
  },
  {
    id: "event-2",
    calendarId: "team",
    title: "디자인 리뷰",
    start: shiftDate(1, 14),
    end: shiftDate(1, 15),
    allDay: false,
    description: "Desktop Dock Mode 와이어프레임 검토",
    location: "회의실 B",
    color: "#2f6c5e"
  },
  {
    id: "event-3",
    calendarId: "primary",
    title: "집중 작업 블록",
    start: shiftDate(2, 9),
    end: shiftDate(2, 12),
    allDay: false,
    description: "OAuth 연동 흐름 구현",
    color: "#8a5cf6"
  }
];

export const initialTasks: TaskItem[] = [
  {
    id: "task-1",
    taskListId: "work",
    title: "Google OAuth 클라이언트 등록",
    due: shiftDate(0, 0).slice(0, 10),
    notes: "Loopback redirect URI 사용",
    completed: false,
    updatedAt: new Date().toISOString()
  },
  {
    id: "task-2",
    taskListId: "personal",
    title: "캘린더 색상 정리",
    due: shiftDate(1, 0).slice(0, 10),
    notes: "기본/강조 색상 대비 확인",
    completed: false,
    updatedAt: new Date().toISOString()
  },
  {
    id: "task-3",
    taskListId: "work",
    title: "SQLite 스키마 초안 검토",
    due: shiftDate(2, 0).slice(0, 10),
    notes: "events_cache, tasks_cache, sync_state 포함",
    completed: true,
    updatedAt: new Date().toISOString()
  }
];

export const defaultSettings: Settings = {
  dockMode: false,
  dockSide: "left",
  alwaysOnTop: false,
  launchInDockMode: false,
  rememberWindowState: true,
  autoSyncMinutes: 15,
  showCompletedTasks: true,
  calendarColorOverrides: {}
};
