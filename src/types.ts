export type CalendarViewMode = "dayGridMonth" | "timeGridWeek" | "timeGridDay";

export type CalendarInfo = {
  id: string;
  name: string;
  color: string;
};

export type TaskListInfo = {
  id: string;
  name: string;
  color: string;
};

export type CalendarEvent = {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  description?: string;
  location?: string;
  guests?: string[];
  color?: string;
};

export type TaskItem = {
  id: string;
  taskListId: string;
  title: string;
  due?: string;
  notes?: string;
  location?: string;
  completed: boolean;
  updatedAt: string;
};

export type DockSettings = {
  dockMode: boolean;
  dockSide: "left" | "right";
  alwaysOnTop: boolean;
  launchInDockMode: boolean;
  rememberWindowState: boolean;
};

export type Settings = DockSettings & {
  autoSyncMinutes: number;
  showCompletedTasks: boolean;
  calendarColorOverrides?: Record<string, string>;
};

export type SelectionState =
  | { type: "event"; id: string }
  | { type: "task"; id: string }
  | { type: "date"; date: string }
  | null;

export type GoogleSession = {
  email?: string;
  name?: string;
  picture?: string;
  scopes: string[];
};

export type GoogleCalendarListEntry = {
  id: string;
  summary: string;
  primary: boolean;
  selected: boolean;
  backgroundColor?: string;
  foregroundColor?: string;
  accessRole?: string;
};

export type GoogleCalendarEvent = {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  description?: string;
  location?: string;
  guests?: string[];
  color?: string;
  source: "google";
};

export type GoogleTaskListEntry = {
  id: string;
  title: string;
};

export type GoogleTaskItem = {
  id: string;
  taskListId: string;
  title: string;
  due?: string;
  notes?: string;
  location?: string;
  completed: boolean;
  updatedAt: string;
};
