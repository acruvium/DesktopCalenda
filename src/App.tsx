import { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import type {
  DatesSetArg,
  EventContentArg,
  EventClickArg,
  EventDropArg
} from "@fullcalendar/core";
import type { DateClickArg, EventResizeDoneArg } from "@fullcalendar/interaction";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import clsx from "clsx";
import packageJson from "../package.json";
import {
  GOOGLE_ALLOW_INSECURE_TLS,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET
} from "./config";
import {
  defaultSettings,
  initialCalendars,
  initialEvents,
  initialTaskLists,
  initialTasks
} from "./data";
import { formatDateLabel, formatDateTimeLabel, isSameDate } from "./lib/date";
import {
  deleteGoogleTask,
  deleteGooglePrimaryEvent,
  fetchGoogleCalendarList,
  fetchGooglePrimaryEvents,
  fetchGoogleTaskLists,
  fetchGoogleTasks,
  googleRestoreSession,
  googleSignIn,
  googleSignOut,
  createGoogleTask,
  updateGoogleTask,
  updateGoogleTaskCompletion,
  updateGoogleTaskDue,
  upsertGooglePrimaryEvent
} from "./lib/google";
import { applyDockSettings, isTauriRuntime, openExternalUrl } from "./lib/tauri";
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarViewMode,
  GoogleCalendarEvent,
  GoogleCalendarListEntry,
  GoogleTaskItem,
  GoogleTaskListEntry,
  GoogleSession,
  SelectionState,
  Settings,
  TaskItem,
  TaskListInfo
} from "./types";

const STORAGE_KEYS = {
  events: "desk-calendar-dock.events",
  tasks: "desk-calendar-dock.tasks",
  settings: "desk-calendar-dock.settings"
} as const;
const TASK_LIST_OPTION_PREFIX = "tasklist:";
const VIRTUAL_BIRTHDAYS_ID = "__virtual_birthdays__";
const VIRTUAL_TASKS_ID = "__virtual_tasks__";
const EVENT_HOUR_MIN = 9;
const EVENT_HOUR_MAX = 18;
const CALENDAR_SLOT_MIN_TIME = "09:00:00";
const CALENDAR_SLOT_MAX_TIME = "18:00:00";
const APP_VERSION = packageJson.version;

const readJson = <T,>(key: string, fallback: T): T => {
  if (typeof window === "undefined") {
    return fallback;
  }

  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const direct = [record.message, record.error, record.cause].find(
      (value) => typeof value === "string" && value.trim().length > 0
    );
    if (typeof direct === "string") {
      return direct;
    }

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore and use fallback below.
    }
  }

  return "Unknown desktop runtime error.";
};

type DraftPanel =
  | {
      kind: "event";
      value: CalendarEvent;
      isNew: boolean;
    }
  | {
      kind: "task";
      value: TaskItem;
      isNew: boolean;
    }
  | null;

type CalendarOption = {
  id: string;
  label: string;
  color: string;
  selected: boolean;
  primary?: boolean;
  kind: "calendar" | "taskList";
};

const createEventDraft = (
  calendars: CalendarInfo[],
  date?: string
): CalendarEvent => {
  const baseDate = date ?? toKstDateKey(new Date()) ?? new Date().toISOString().slice(0, 10);
  const start = new Date(`${baseDate}T${String(EVENT_HOUR_MIN).padStart(2, "0")}:00:00+09:00`);
  const endDate = new Date(`${baseDate}T${String(EVENT_HOUR_MAX).padStart(2, "0")}:00:00+09:00`);

  return {
    id: `event-${crypto.randomUUID()}`,
    calendarId: calendars[0]?.id ?? "primary",
    title: "",
    start: start.toISOString(),
    end: endDate.toISOString(),
    allDay: false,
    description: "",
    location: "",
    guests: [],
    color: calendars[0]?.color ?? "#d96b39"
  };
};

const createTaskDraft = (taskLists: TaskListInfo[], date?: string): TaskItem => ({
  id: `task-${crypto.randomUUID()}`,
  taskListId: taskLists[0]?.id ?? "personal",
  title: "",
  due: date ?? toKstDateKey(new Date()) ?? new Date().toISOString().slice(0, 10),
  notes: "",
  completed: false,
  updatedAt: new Date().toISOString()
});

const getDraftAnchorDate = (draft: DraftPanel): string | undefined => {
  if (!draft) {
    return undefined;
  }
  if (draft.kind === "event") {
    return draft.value.start.slice(0, 10);
  }
  return draft.value.due;
};

const addDays = (dateOnly: string, days: number) => {
  const date = new Date(`${dateOnly}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toLocalDateKey(date);
};

const normalizeEventEnd = (start: string, end: string | undefined, allDay: boolean) => {
  if (allDay) {
    const startDate = start.slice(0, 10);
    const endDate = end?.slice(0, 10);
    if (!endDate || endDate <= startDate) {
      return addDays(startDate, 1);
    }
    return endDate;
  }

  if (end) {
    return end;
  }

  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) {
    return start;
  }
  startDate.setHours(startDate.getHours() + 1);
  return startDate.toISOString();
};

const shiftDateOnly = (dateOnly: string, dayDelta: number) => {
  const date = new Date(`${dateOnly}T00:00:00`);
  date.setDate(date.getDate() + dayDelta);
  return toLocalDateKey(date);
};

const shiftIsoKeepingClock = (isoDateTime: string, dayDelta: number) => {
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) {
    return isoDateTime;
  }
  date.setDate(date.getDate() + dayDelta);
  return date.toISOString();
};

const extractDateOnly = (value?: string | null) => {
  if (!value) {
    return undefined;
  }
  return value.length >= 10 ? value.slice(0, 10) : undefined;
};

const KST_TZ = "Asia/Seoul";
const DATE_KEY_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: KST_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const toLocalDateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;

const toKstDateKey = (value?: string | Date | null) => {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return DATE_KEY_FORMATTER.format(date);
};

const toDateTimeLocalInput = (iso?: string) => {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: KST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const fromDateTimeLocalInput = (value: string, fallback: string) => {
  if (!value) {
    return fallback;
  }
  // Interpret the user-entered datetime-local value as KST.
  const date = new Date(`${value}:00+09:00`);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date.toISOString();
};

const isWithinEventHours = (iso?: string) => {
  if (!iso) {
    return false;
  }
  const localValue = toDateTimeLocalInput(iso);
  const timePart = localValue.split("T")[1];
  if (!timePart) {
    return false;
  }
  return timePart >= "09:00" && timePart <= "18:00";
};

const getDateTimeInputBounds = (iso?: string) => {
  const localValue = toDateTimeLocalInput(iso);
  const datePart = localValue.split("T")[0];
  if (!datePart) {
    return {};
  }
  return {
    min: `${datePart}T09:00`,
    max: `${datePart}T18:00`
  };
};

const toCalendarEvent = (
  event: GoogleCalendarEvent,
  fallbackColor?: string
): CalendarEvent => ({
  id: event.id,
  calendarId: event.calendarId,
  title: event.title,
  start: event.start,
  end: normalizeEventEnd(event.start, event.end, event.allDay),
  allDay: event.allDay,
  description: event.description,
  location: event.location,
  guests: event.guests,
  color: event.color ?? fallbackColor
});

const toEditableEventDraft = (event: CalendarEvent): CalendarEvent => ({
  ...event,
  description: event.description ?? "",
  location: event.location ?? "",
  guests: [...(event.guests ?? [])]
});
const toEditableTaskDraft = (task: GoogleTaskItem | TaskItem): TaskItem => ({
  ...task,
  due: task.due,
  notes: task.notes ?? "",
  location: task.location ?? "",
  completed: task.completed
});
const COPY_SUFFIX = " (Copy)";
const toDuplicateTitle = (title: string) =>
  title.trim() ? `${title.trim()}${COPY_SUFFIX}` : `Untitled${COPY_SUFFIX}`;

const DEFAULT_MAPS_LOCATION = "37.478234,126.951572";
const DEFAULT_MAPS_ZOOM_LEVEL = "19";
const COORDINATE_QUERY_REGEX =
  /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const MAPS_LAYER = "transit";
const buildGoogleMapsUrl = (query?: string) => {
  const normalized = query?.trim() || DEFAULT_MAPS_LOCATION;
  const coordinateMatch = normalized.match(COORDINATE_QUERY_REGEX);
  const nonce = String(Date.now());
  const params = new URLSearchParams({
    q: normalized,
    z: DEFAULT_MAPS_ZOOM_LEVEL,
    layer: MAPS_LAYER,
    hl: "ko",
    nav: nonce
  });

  if (coordinateMatch) {
    const center = `${coordinateMatch[1]},${coordinateMatch[2]}`;
    params.set("ll", center);
  }

  return `https://www.google.com/maps?${params.toString()}`;
};

const toSafeDate = (value?: string) => {
  if (!value) {
    return null;
  }
  const normalized = value.length === 10 ? `${value}T00:00:00` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toTaskListOptionId = (taskListId: string) => `${TASK_LIST_OPTION_PREFIX}${taskListId}`;
const TASK_LIKE_REGEX = /(task|tasks|todo|to-do|할\s*일|작업)/i;
const HOLIDAY_CALENDAR_REGEX = /(holiday|holidays|휴일)/i;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

const hexToRgba = (hex: string, alpha: number) => {
  const normalized = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return `rgba(79, 126, 220, ${alpha})`;
  }
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const normalizeCalendarLabel = (
  summary: string,
  calendarId: string,
  _isPrimary: boolean,
  _session: GoogleSession | null
) => {
  const text = summary.trim();
  return text || "Calendar";
};

const isBirthdaysCalendar = (summary: string, calendarId: string) => {
  const lower = summary.trim().toLowerCase();
  const idLower = calendarId.toLowerCase();
  return lower.includes("birthday") || idLower.includes("contacts@group.v.calendar.google.com");
};

const isTaskLikeCalendar = (summary: string, calendarId: string) =>
  TASK_LIKE_REGEX.test(summary) || TASK_LIKE_REGEX.test(calendarId);

const isHolidayCalendar = (summary: string, calendarId: string) =>
  HOLIDAY_CALENDAR_REGEX.test(summary) || HOLIDAY_CALENDAR_REGEX.test(calendarId);

const getTaskLocation = (task: GoogleTaskItem | TaskItem) => task.location?.trim() ?? "";

function App() {
  const calendarRef = useRef<FullCalendar | null>(null);
  const lastEventClickRef = useRef<{ id: string; ts: number } | null>(null);
  const [calendars] = useState<CalendarInfo[]>(initialCalendars);
  const [taskLists] = useState<TaskListInfo[]>(initialTaskLists);
  const [events, setEvents] = useState<CalendarEvent[]>(() =>
    readJson(STORAGE_KEYS.events, initialEvents)
  );
  const [tasks, setTasks] = useState<TaskItem[]>(() =>
    readJson(STORAGE_KEYS.tasks, initialTasks)
  );
  const [settings, setSettings] = useState<Settings>(() =>
    readJson(STORAGE_KEYS.settings, defaultSettings)
  );
  const [viewMode, setViewMode] = useState<CalendarViewMode>("dayGridMonth");
  const [selection, setSelection] = useState<SelectionState>({
    type: "date",
    date: toKstDateKey(new Date()) ?? toLocalDateKey(new Date())
  });
  const [draft, setDraft] = useState<DraftPanel>(null);
  const [status, setStatus] = useState(
    "Sign in with Google to load your calendar list, events, and tasks."
  );
  const [googleSession, setGoogleSession] = useState<GoogleSession | null>(null);
  const [googleCalendars, setGoogleCalendars] = useState<GoogleCalendarListEntry[]>([]);
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]);
  const [googleTaskLists, setGoogleTaskLists] = useState<GoogleTaskListEntry[]>([]);
  const [googleTasks, setGoogleTasks] = useState<GoogleTaskItem[]>([]);
  const [authBusy, setAuthBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreTried, setRestoreTried] = useState(false);
  const [viewTitle, setViewTitle] = useState("Month");
  const [miniCalendarCursor, setMiniCalendarCursor] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [visibleCalendarIds, setVisibleCalendarIds] = useState<string[]>([]);
  const [myCalendarsCollapsed, setMyCalendarsCollapsed] = useState(false);
  const [googleTaskCompletionOverrides, setGoogleTaskCompletionOverrides] = useState<
    Record<string, boolean>
  >({});
  const [googleTaskDueOverrides, setGoogleTaskDueOverrides] = useState<
    Record<string, string | undefined>
  >({});

  const hasGoogleTasksWriteScope = useMemo(
    () =>
      !!googleSession?.scopes?.some(
        (scope) => scope === "https://www.googleapis.com/auth/tasks"
      ),
    [googleSession]
  );
  const colorOverrides = settings.calendarColorOverrides ?? {};
  const getOverrideColor = (id: string, fallback: string) => {
    const override = colorOverrides[id]?.trim();
    if (override && HEX_COLOR_REGEX.test(override)) {
      return override;
    }
    return fallback;
  };
  const getEventColor = (event: Pick<CalendarEvent, "calendarId" | "color">) =>
    getOverrideColor(
      event.calendarId,
      googleCalendarColorById[event.calendarId] ?? event.color ?? "#3c6df0"
    );

  const googleEventColorByCalendarId = useMemo(() => {
    return googleEvents.reduce<Record<string, string>>((accumulator, event) => {
      if (!event.color) {
        return accumulator;
      }
      if (!accumulator[event.calendarId]) {
        accumulator[event.calendarId] = event.color;
      }
      return accumulator;
    }, {});
  }, [googleEvents]);

  const googleCalendarColorById = useMemo(() => {
    return googleCalendars.reduce<Record<string, string>>((accumulator, calendar) => {
      accumulator[calendar.id] =
        calendar.backgroundColor ?? googleEventColorByCalendarId[calendar.id] ?? "#3c6df0";
      return accumulator;
    }, {});
  }, [googleCalendars, googleEventColorByCalendarId]);

  const googleTasksBaseColor = useMemo(() => {
    if (!googleSession) {
      return "#8ab4f8";
    }

    const tasksCalendar = googleCalendars.find((calendar) => {
      return isTaskLikeCalendar(calendar.summary, calendar.id);
    });

    if (tasksCalendar?.backgroundColor) {
      return tasksCalendar.backgroundColor;
    }

    const taskEventColor = Object.entries(googleEventColorByCalendarId).find(([calendarId]) =>
      TASK_LIKE_REGEX.test(calendarId)
    )?.[1];

    return taskEventColor ?? "#8ab4f8";
  }, [googleCalendars, googleEventColorByCalendarId, googleSession]);
  const defaultTaskOptionId =
    googleTaskLists.length > 0 ? toTaskListOptionId(googleTaskLists[0].id) : VIRTUAL_TASKS_ID;
  const googleTasksDisplayColor = getOverrideColor(defaultTaskOptionId, googleTasksBaseColor);

  const eventDraftCalendars = useMemo<CalendarInfo[]>(() => {
    if (googleSession) {
      if (googleCalendars.length === 0) {
        return [{ id: "primary", name: "Primary", color: "#3c6df0" }];
      }
      return googleCalendars.map((item) => ({
        id: item.id,
        name: normalizeCalendarLabel(item.summary, item.id, item.primary, googleSession),
        color: getOverrideColor(item.id, item.backgroundColor ?? "#3c6df0")
      }));
    }
    return calendars;
  }, [calendars, colorOverrides, googleCalendars, googleSession]);

  const taskDraftLists = useMemo<TaskListInfo[]>(() => {
    if (googleSession) {
      return googleTaskLists.map((item) => ({
        id: item.id,
        name: item.title,
        color: getOverrideColor(toTaskListOptionId(item.id), googleTasksDisplayColor)
      }));
    }
    return taskLists;
  }, [colorOverrides, googleSession, googleTaskLists, googleTasksDisplayColor, taskLists]);

  const calendarOptions = useMemo<CalendarOption[]>(() => {
    if (googleSession) {
      const seen = new Set<string>();
      const googleCalendarOptions: CalendarOption[] = googleCalendars.map((item) => {
        seen.add(item.id);
        const label = normalizeCalendarLabel(
          item.summary,
          item.id,
          item.primary,
          googleSession
        );
        return {
          id: item.id,
          label,
          color: getOverrideColor(
            item.id,
            item.backgroundColor ?? googleEventColorByCalendarId[item.id] ?? "#3c6df0"
          ),
          selected: item.selected,
          primary: item.primary,
          kind: "calendar" as const
        };
      });
      const inferredCalendarOptions: CalendarOption[] = googleEvents
        .map((event) => event.calendarId)
        .filter((id) => {
          if (!id || seen.has(id)) {
            return false;
          }
          seen.add(id);
          return true;
        })
        .map((id) => ({
          id,
          label: "Calendar",
          color: getOverrideColor(id, googleCalendarColorById[id] ?? "#3c6df0"),
          selected: true,
          primary: false,
          kind: "calendar" as const
        }));
      const merged: CalendarOption[] = [
        ...googleCalendarOptions,
        ...inferredCalendarOptions
      ];
      const hasBirthdays = googleCalendars.some((item) =>
        isBirthdaysCalendar(item.summary, item.id)
      );
      const hasTasksCalendar = googleCalendars.some((item) =>
        isTaskLikeCalendar(item.summary, item.id)
      );

      if (!hasBirthdays) {
        merged.push({
          id: VIRTUAL_BIRTHDAYS_ID,
          label: "Birthdays",
          color: getOverrideColor(VIRTUAL_BIRTHDAYS_ID, "#3ddc97"),
          selected: false,
          primary: false,
          kind: "calendar" as const
        });
      }

      if (googleTaskLists.length > 0) {
        merged.push({
          id: toTaskListOptionId(googleTaskLists[0].id),
          label: "Tasks",
          color: getOverrideColor(
            toTaskListOptionId(googleTaskLists[0].id),
            googleTasksDisplayColor
          ),
          selected: true,
          primary: false,
          kind: "taskList" as const
        });
      } else if (!hasTasksCalendar) {
        merged.push({
          id: VIRTUAL_TASKS_ID,
          label: "Tasks",
          color: getOverrideColor(VIRTUAL_TASKS_ID, googleTasksDisplayColor),
          selected: true,
          primary: false,
          kind: "calendar" as const
        });
      }

      return merged.sort((a, b) => {
        const order = (item: CalendarOption) => {
          if (item.primary) {
            return 0;
          }
          if (item.label === "Birthdays") {
            return 1;
          }
          if (item.label === "Tasks") {
            return 2;
          }
          return 1;
        };
        return order(a) - order(b) || a.label.localeCompare(b.label);
      });
    }

    return calendars.map((item) => ({
      id: item.id,
      label: item.name,
      color: getOverrideColor(item.id, item.color),
      selected: true,
      primary: false,
      kind: "calendar" as const
    }));
  }, [
    calendars,
    colorOverrides,
    googleCalendars,
    googleEventColorByCalendarId,
    googleEvents,
    googleSession,
    googleCalendarColorById,
    googleTaskLists,
    googleTasksDisplayColor
  ]);

  useEffect(() => {
    setVisibleCalendarIds((current) => {
      const optionIds = calendarOptions.map((item) => item.id);
      if (optionIds.length === 0) {
        return [];
      }

      if (googleSession) {
        const selectedCalendarIds = calendarOptions
          .filter((item) => item.selected)
          .map((item) => item.id);
        // Keep the user's current check state unless this is the first initialization.
        if (current.length === 0) {
          return selectedCalendarIds.length > 0 ? selectedCalendarIds : optionIds;
        }

        const next = current.filter((id) => optionIds.includes(id));
        if (next.length > 0) {
          return next;
        }

        return selectedCalendarIds.length > 0 ? selectedCalendarIds : optionIds;
      }

      if (current.length === 0) {
        return optionIds;
      }

      const next = current.filter((id) => optionIds.includes(id));
      return next.length === 0 ? optionIds : next;
    });
  }, [calendarOptions, googleSession]);

  const useGoogleData = !!googleSession || restoreBusy;

  const displayedEventsRaw = useGoogleData
    ? googleEvents.map((event) =>
        toCalendarEvent(
          event,
          getEventColor(event)
        )
      )
    : events.map((event) => ({
        ...event,
        color: getEventColor(event)
      }));
  const displayedEvents =
    visibleCalendarIds.length === 0
      ? displayedEventsRaw
      : displayedEventsRaw.filter((event) =>
          visibleCalendarIds.includes(event.calendarId)
        );
  const hiddenUpcomingCalendarIds = useMemo(() => {
    const ids = new Set<string>();

    for (const calendar of calendars) {
      if (isHolidayCalendar(calendar.name, calendar.id)) {
        ids.add(calendar.id);
      }
    }

    for (const calendar of googleCalendars) {
      if (isHolidayCalendar(calendar.summary, calendar.id)) {
        ids.add(calendar.id);
      }
    }

    for (const event of googleEvents) {
      if (HOLIDAY_CALENDAR_REGEX.test(event.calendarId)) {
        ids.add(event.calendarId);
      }
    }

    return ids;
  }, [calendars, googleCalendars, googleEvents]);
  const taskCalendarIds = useMemo(
    () => {
      const ids = new Set<string>();

      for (const calendar of googleCalendars) {
        if (isTaskLikeCalendar(calendar.summary, calendar.id)) {
          ids.add(calendar.id);
        }
      }

      // Fallback: infer task-like calendars from event calendar ids as well.
      for (const event of googleEvents) {
        if (TASK_LIKE_REGEX.test(event.calendarId)) {
          ids.add(event.calendarId);
        }
      }

      return Array.from(ids);
    },
    [googleCalendars, googleEvents]
  );

  const fallbackGoogleTasks = useMemo(() => {
    if (!googleSession || taskCalendarIds.length === 0) {
      return [] as GoogleTaskItem[];
    }

    return googleEvents
      .filter((event) => taskCalendarIds.includes(event.calendarId))
      .map((event) => ({
        id: `fallback-${event.id}`,
        taskListId: "google-tasks-calendar",
        title: event.title,
        due: event.start?.slice(0, 10),
        notes: event.description,
        location: event.location,
        completed: false,
        updatedAt: event.start
      }));
  }, [googleEvents, googleSession, taskCalendarIds]);

  const displayedTasks = useGoogleData
    ? googleTasks.length > 0
      ? googleTasks
      : fallbackGoogleTasks
    : tasks;

  const isTaskCompleted = (task: GoogleTaskItem | TaskItem) =>
    googleTaskCompletionOverrides[task.id] ?? task.completed;
  const getTaskDue = (task: GoogleTaskItem | TaskItem) =>
    googleTaskDueOverrides[task.id] ?? task.due;
  const getTaskColor = (task: GoogleTaskItem | TaskItem) => {
    const taskOptionId = toTaskListOptionId(task.taskListId);
    return getOverrideColor(taskOptionId, googleTasksDisplayColor);
  };

  const filteredDisplayedTasks = useMemo(() => {
    if (!googleSession) {
      return displayedTasks;
    }
    const taskOption = calendarOptions.find((item) => item.kind === "taskList");
    if (!taskOption) {
      return displayedTasks;
    }
    const isVisible = visibleCalendarIds.includes(taskOption.id);
    return isVisible ? displayedTasks : [];
  }, [calendarOptions, displayedTasks, googleSession, visibleCalendarIds]);

  const selectedDate = useMemo(() => {
    if (!selection) {
      return undefined;
    }

    if (selection.type === "date") {
      return selection.date;
    }

    if (selection.type === "task") {
      const task = filteredDisplayedTasks.find((item) => item.id === selection.id);
      return task ? getTaskDue(task) : undefined;
    }

    return toKstDateKey(
      displayedEvents.find((event) => event.id === selection.id)?.start
    );
  }, [displayedEvents, filteredDisplayedTasks, selection]);

  const selectedEvent =
    selection?.type === "event"
      ? displayedEvents.find((event) => event.id === selection.id) ?? null
      : null;

  const selectedTask =
    selection?.type === "task"
      ? filteredDisplayedTasks.find((task) => task.id === selection.id) ?? null
      : null;

  useEffect(() => {
    if (!selectedDate) {
      return;
    }

    const [year, month] = selectedDate.split("-").map(Number);
    if (!year || !month) {
      return;
    }

    setMiniCalendarCursor((current) => {
      if (current.getFullYear() === year && current.getMonth() === month - 1) {
        return current;
      }

      return new Date(year, month - 1, 1);
    });
  }, [selectedDate]);

  const dayTasks = useMemo(() => {
    return filteredDisplayedTasks.filter((task) => {
      if (!settings.showCompletedTasks && isTaskCompleted(task)) {
        return false;
      }

      return selectedDate ? isSameDate(getTaskDue(task), selectedDate) : true;
    });
  }, [filteredDisplayedTasks, googleTaskCompletionOverrides, googleTaskDueOverrides, selectedDate, settings.showCompletedTasks]);

  const taskCountByDate = useMemo(() => {
    return filteredDisplayedTasks.reduce<Record<string, number>>((accumulator, task) => {
      const due = getTaskDue(task);
      if (!due) {
        return accumulator;
      }

      if (!settings.showCompletedTasks && isTaskCompleted(task)) {
        return accumulator;
      }

      accumulator[due] = (accumulator[due] ?? 0) + 1;
      return accumulator;
    }, {});
  }, [filteredDisplayedTasks, googleTaskCompletionOverrides, googleTaskDueOverrides, settings.showCompletedTasks]);

  const todayDateKey = useMemo(() => toKstDateKey(new Date()) ?? "", []);
  const isPastListDate = (value?: string) => {
    if (!value) {
      return false;
    }
    const dateKey = toKstDateKey(value);
    if (!dateKey) {
      return false;
    }
    return dateKey < todayDateKey;
  };

  const scheduleItems = useMemo(() => {
    const eventItems = displayedEvents
      .filter((event) => !hiddenUpcomingCalendarIds.has(event.calendarId))
      .filter((event) => !isPastListDate(event.start))
      .map((event) => ({
        id: `event-${event.id}`,
        type: "event" as const,
        title: event.title,
        dateKey: toKstDateKey(event.start) ?? event.start ?? "",
        color: getEventColor(event),
        isPast: false,
        event
      }));

    const taskItems = filteredDisplayedTasks
      .filter((task) => !isTaskCompleted(task))
      .map((task) => {
        const due = getTaskDue(task);
        return {
          id: `task-${task.id}`,
          type: "task" as const,
          title: task.title,
          dateKey: due ?? "9999-12-31",
          color: getTaskColor(task),
          isPast: isPastListDate(due),
          task
        };
      });

    return [...eventItems, ...taskItems].sort((a, b) => {
      const byDate = a.dateKey.localeCompare(b.dateKey);
      if (byDate !== 0) {
        return byDate;
      }
      if (a.type !== b.type) {
        return a.type === "event" ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    });
  }, [
    displayedEvents,
    filteredDisplayedTasks,
    hiddenUpcomingCalendarIds,
    googleTaskCompletionOverrides,
    googleTaskDueOverrides,
    todayDateKey
  ]);

  const calendarTaskEntries = useMemo(
    () => {
      const perDay = new Map<string, number>();
      return filteredDisplayedTasks
        .filter((task) => !!getTaskDue(task))
        .filter((task) => settings.showCompletedTasks || !isTaskCompleted(task))
        .filter((task) => {
          const due = getTaskDue(task);
          if (!due) {
            return false;
          }
          const current = perDay.get(due) ?? 0;
          if (current >= 3) {
            return false;
          }
          perDay.set(due, current + 1);
          return true;
        })
        .map((task) => {
          const taskColor = getTaskColor(task);
          return {
            id: `task-entry-${task.id}`,
            title: task.title,
            start: getTaskDue(task)!,
            allDay: true,
            editable: true,
            startEditable: true,
            durationEditable: false,
            backgroundColor: hexToRgba(taskColor, 0.22),
            borderColor: taskColor,
            textColor: taskColor,
            extendedProps: {
              itemType: "task",
              taskId: task.id,
              taskCompleted: isTaskCompleted(task),
              displayColor: taskColor
            }
          };
        });
    },
    [
      filteredDisplayedTasks,
      googleTaskCompletionOverrides,
      googleTaskDueOverrides,
      colorOverrides,
      settings.showCompletedTasks
    ]
  );

  useEffect(() => {
    const movableSettings = {
      ...settings,
      dockMode: false,
      launchInDockMode: false,
      alwaysOnTop: false
    };
    void applyDockSettings(movableSettings).catch(() => {
      setStatus("Dock settings are only applied in the desktop runtime.");
    });
    if (settings.dockMode || settings.launchInDockMode || settings.alwaysOnTop) {
      setSettings((current) => ({
        ...current,
        dockMode: false,
        launchInDockMode: false,
        alwaysOnTop: false
      }));
    }
  }, [settings]);

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (api && api.view.type !== viewMode) {
      api.changeView(viewMode);
    }
  }, [viewMode]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.events, JSON.stringify(events));
  }, [events]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!isTauriRuntime || restoreTried) {
      return;
    }

    setRestoreTried(true);
    setRestoreBusy(true);
    setStatus("Checking saved Google session...");
    void googleRestoreSession()
      .then(async (session) => {
        if (!session) {
          setStatus("No saved Google session.");
          return;
        }

        await refreshGoogleData();
        setGoogleSession(session);
        setStatus(
          session.email
            ? `Restored session for ${session.email}.`
            : "Restored Google session."
        );
      })
      .catch((error) => {
        setStatus(
          error instanceof Error ? error.message : "Failed to restore Google session."
        );
      })
      .finally(() => {
        setRestoreBusy(false);
      });
  }, [restoreTried]);

  const getVisibleRange = () => {
    const api = calendarRef.current?.getApi();
    if (!api) {
      const now = new Date();
      return {
        timeMin: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        timeMax: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
      };
    }

    return {
      timeMin: api.view.activeStart.toISOString(),
      timeMax: api.view.activeEnd.toISOString()
    };
  };

  const getSyncRange = () => {
    const { timeMin, timeMax } = getVisibleRange();
    const from = new Date(timeMin);
    const to = new Date(timeMax);
    from.setDate(from.getDate() - 45);
    to.setDate(to.getDate() + 120);
    return {
      timeMin: from.toISOString(),
      timeMax: to.toISOString()
    };
  };

  const refreshGoogleData = async () => {
    const { timeMin, timeMax } = getSyncRange();
    const [calendarListResult, primaryEventsResult, taskListsResult, tasksResult] =
      await Promise.allSettled([
        fetchGoogleCalendarList(),
        fetchGooglePrimaryEvents(timeMin, timeMax),
        fetchGoogleTaskLists(),
        fetchGoogleTasks()
      ]);
    if (calendarListResult.status === "fulfilled") {
      setGoogleCalendars(calendarListResult.value);
    }
    if (primaryEventsResult.status === "fulfilled") {
      setGoogleEvents(primaryEventsResult.value);
    }

    const tasksBlocked =
      (taskListsResult.status === "rejected" &&
        String(taskListsResult.reason).includes("403")) ||
      (tasksResult.status === "rejected" &&
        String(tasksResult.reason).includes("403"));

    if (taskListsResult.status === "fulfilled") {
      setGoogleTaskLists(taskListsResult.value);
    }

    if (tasksResult.status === "fulfilled") {
      setGoogleTasks(tasksResult.value);
    }

    if (
      calendarListResult.status === "rejected" &&
      primaryEventsResult.status === "rejected"
    ) {
      throw primaryEventsResult.reason ?? calendarListResult.reason;
    }

    const calendarsCount =
      calendarListResult.status === "fulfilled"
        ? calendarListResult.value.length
        : googleCalendars.length;
    const eventsCount =
      primaryEventsResult.status === "fulfilled"
        ? primaryEventsResult.value.length
        : googleEvents.length;
    const taskListsCount =
      taskListsResult.status === "fulfilled"
        ? taskListsResult.value.length
        : googleTaskLists.length;
    const tasksCount = tasksResult.status === "fulfilled" ? tasksResult.value.length : googleTasks.length;

    if (tasksBlocked) {
      setStatus(
        `Google calendars/events loaded (${calendarsCount} calendars, ${eventsCount} events, ${taskListsCount} task lists). Google Tasks API access is blocked (403) for this account.`
      );
      return;
    }

    if (
      taskListsResult.status === "rejected" ||
      tasksResult.status === "rejected" ||
      primaryEventsResult.status === "rejected" ||
      calendarListResult.status === "rejected"
    ) {
      const taskListError =
        taskListsResult.status === "rejected"
          ? ` taskLists: ${String(taskListsResult.reason)}`
          : "";
      const taskError =
        tasksResult.status === "rejected"
          ? ` tasks: ${String(tasksResult.reason)}`
          : "";
      setStatus(
        `Google sync partially loaded (${calendarsCount} calendars, ${eventsCount} events, ${taskListsCount} task lists, ${tasksCount} tasks).${taskListError}${taskError}`
      );
      return;
    }

    setStatus(
      `Loaded Google data (${calendarsCount} calendars, ${eventsCount} events, ${taskListsCount} task lists, ${tasksCount} tasks).`
    );
  };

  const handleGoogleSignIn = async () => {
    if (!GOOGLE_OAUTH_CLIENT_ID.trim()) {
      const message =
        "Set GOOGLE_OAUTH_CLIENT_ID in src/config.ts first.";
      setStatus(message);
      window.alert(message);
      return;
    }

    setAuthBusy(true);
    setStatus("Opening your browser for Google sign-in...");
    try {
      const session = await googleSignIn(
        GOOGLE_OAUTH_CLIENT_ID.trim(),
        GOOGLE_ALLOW_INSECURE_TLS,
        GOOGLE_OAUTH_CLIENT_SECRET.trim() || undefined
      );
      setGoogleSession(session);
      try {
        await refreshGoogleData();
        setStatus(
          session.email
            ? `Signed in as ${session.email}.`
            : "Signed in with Google."
        );
      } catch (refreshError) {
        const refreshMessage = getErrorMessage(refreshError);
        setStatus(
          `Signed in successfully, but Google sync failed: ${refreshMessage}`
        );
      }
    } catch (error) {
      const message = getErrorMessage(error);

      // If the front-end timed out while browser consent was still in progress,
      // try restoring a newly saved session before showing a hard failure.
      if (message === "The desktop command timed out.") {
        try {
          const restored = await googleRestoreSession();
          if (restored) {
            setGoogleSession(restored);
            try {
              await refreshGoogleData();
              setStatus(
                restored.email
                  ? `Signed in as ${restored.email}.`
                  : "Signed in with Google."
              );
            } catch (refreshError) {
              const refreshMessage = getErrorMessage(refreshError);
              setStatus(
                `Signed in successfully, but Google sync failed: ${refreshMessage}`
              );
            }
            return;
          }
        } catch {
          // Fall through to the existing error handling.
        }
      }

      setStatus(message);
      window.alert(`Google sign-in failed: ${message}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleRefresh = async () => {
    setAuthBusy(true);
    try {
      await refreshGoogleData();
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Calendar refresh failed."
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleSignOut = async () => {
    setAuthBusy(true);
    try {
      await googleSignOut();
      setGoogleSession(null);
      setGoogleCalendars([]);
      setGoogleEvents([]);
      setGoogleTaskLists([]);
      setGoogleTasks([]);
      setStatus("Signed out from Google.");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Google sign-out failed."
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const openNewEvent = (date?: string) => {
    setDraft({
      kind: "event",
      value: createEventDraft(eventDraftCalendars, date),
      isNew: true
    });
  };

  const openNewTask = (date?: string) => {
    if (googleSession && googleTaskLists.length === 0) {
      setStatus("No Google task list loaded yet. Refresh once and try again.");
      return;
    }
    setDraft({
      kind: "task",
      value: createTaskDraft(taskDraftLists, date),
      isNew: true
    });
  };

  const switchDraftKind = (kind: "event" | "task") => {
    const anchorDate = getDraftAnchorDate(draft);
    if (kind === "event") {
      setDraft({
        kind: "event",
        value: createEventDraft(eventDraftCalendars, anchorDate),
        isNew: true
      });
      return;
    }
    setDraft({
      kind: "task",
      value: createTaskDraft(taskDraftLists, anchorDate),
      isNew: true
    });
  };

  const saveDraft = async () => {
    if (!draft || saveBusy) {
      return;
    }
    setSaveBusy(true);
    try {

      if (googleSession && draft.kind === "task") {
        const validTaskListIds = new Set(googleTaskLists.map((item) => item.id));
        const resolvedTaskListId = validTaskListIds.has(draft.value.taskListId)
          ? draft.value.taskListId
          : googleTaskLists[0]?.id ?? "";

        if (!draft.value.title.trim()) {
          setStatus("Enter a task title.");
          return;
        }
        if (!resolvedTaskListId.trim()) {
          setStatus("No Google task list selected.");
          return;
        }

        setAuthBusy(true);
        try {
          const created = draft.isNew
            ? await createGoogleTask(
                resolvedTaskListId,
                draft.value.title,
                draft.value.due,
                draft.value.notes
              )
            : await updateGoogleTask(
                resolvedTaskListId,
                draft.value.id,
                draft.value.title,
                draft.value.due,
                draft.value.notes
              );
          await refreshGoogleData();
          setSelection({ type: "task", id: created.id });
          setStatus(draft.isNew ? "Saved Google task." : "Updated Google task.");
          setDraft(null);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Failed to save Google task.");
        } finally {
          setAuthBusy(false);
        }
        return;
      }

      if (draft.kind === "event") {
        if (!draft.value.title.trim()) {
          setStatus("Enter an event title.");
          return;
        }
        if (!isWithinEventHours(draft.value.start) || !isWithinEventHours(draft.value.end)) {
          setStatus("Event time must stay between 09:00 and 18:00.");
          return;
        }
        if (new Date(draft.value.end).getTime() <= new Date(draft.value.start).getTime()) {
          setStatus("Event end time must be after the start time.");
          return;
        }

        if (googleSession) {
          const validCalendarIds = new Set(googleCalendars.map((item) => item.id));
          const resolvedCalendarId = validCalendarIds.has(draft.value.calendarId)
            ? draft.value.calendarId
            : googleCalendars.find((item) => item.primary)?.id ?? googleCalendars[0]?.id ?? "primary";
          const eventToSave: CalendarEvent = {
            ...draft.value,
            calendarId: resolvedCalendarId
          };
          setAuthBusy(true);
          try {
            const saved = await upsertGooglePrimaryEvent(eventToSave);
            await refreshGoogleData();
            setSelection({ type: "event", id: saved.id });
            setStatus("Saved Google event.");
            setDraft(null);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "Failed to save Google event.");
          } finally {
            setAuthBusy(false);
          }
          return;
        }

        setEvents((current) => {
          const next = current.filter((item) => item.id !== draft.value.id);
          return [...next, draft.value].sort((a, b) => a.start.localeCompare(b.start));
        });
        setSelection({ type: "event", id: draft.value.id });
        setStatus("Saved local event.");
        setDraft(null);
        return;
      }

      if (!draft.value.title.trim()) {
        setStatus("Enter a task title.");
        return;
      }

      const nextTask = {
        ...draft.value,
        updatedAt: new Date().toISOString()
      };
      setTasks((current) => {
        const next = current.filter((item) => item.id !== nextTask.id);
        return [...next, nextTask].sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
      });
      setSelection({ type: "task", id: nextTask.id });
      setStatus("Saved local task.");
      setDraft(null);
    } finally {
      setSaveBusy(false);
    }
  };

  const openDraftLocationInMaps = async () => {
    if (!draft || draft.kind !== "event") {
      return;
    }

    const locationQuery = draft.value.location?.trim();

    try {
      await openExternalUrl(buildGoogleMapsUrl(locationQuery));
      setStatus(
        locationQuery
          ? "Opened location in Google Maps."
          : "Opened default location in Google Maps."
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to open Google Maps.");
    }
  };

  const openEventLocationInMaps = async (event: CalendarEvent) => {
    const locationQuery = event.location?.trim();

    try {
      await openExternalUrl(buildGoogleMapsUrl(locationQuery));
      setStatus(
        locationQuery
          ? "Opened location in Google Maps."
          : "Opened default location in Google Maps."
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to open Google Maps.");
    }
  };

  const openTaskLocationInMaps = async (task: GoogleTaskItem | TaskItem) => {
    const locationQuery = getTaskLocation(task);
    if (!locationQuery) {
      setStatus("This task has no location.");
      return;
    }

    try {
      await openExternalUrl(buildGoogleMapsUrl(locationQuery));
      setStatus("Opened task location in Google Maps.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to open Google Maps.");
    }
  };

  const duplicateDraft = async () => {
    if (!draft || draft.isNew || saveBusy) {
      return;
    }

    if (draft.kind === "event") {
      const duplicatedEvent: CalendarEvent = {
        ...draft.value,
        id: `event-${crypto.randomUUID()}`,
        title: toDuplicateTitle(draft.value.title)
      };

      if (googleSession) {
        const validCalendarIds = new Set(googleCalendars.map((item) => item.id));
        const resolvedCalendarId = validCalendarIds.has(duplicatedEvent.calendarId)
          ? duplicatedEvent.calendarId
          : googleCalendars.find((item) => item.primary)?.id ?? googleCalendars[0]?.id ?? "primary";
        setAuthBusy(true);
        try {
          const saved = await upsertGooglePrimaryEvent({
            ...duplicatedEvent,
            calendarId: resolvedCalendarId
          });
          await refreshGoogleData();
          setSelection({ type: "event", id: saved.id });
          setStatus("Duplicated Google event.");
          setDraft(null);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Failed to duplicate Google event.");
        } finally {
          setAuthBusy(false);
        }
        return;
      }

      setEvents((current) => [...current, duplicatedEvent].sort((a, b) => a.start.localeCompare(b.start)));
      setSelection({ type: "event", id: duplicatedEvent.id });
      setStatus("Duplicated local event.");
      setDraft(null);
      return;
    }

    const duplicatedTask: TaskItem = {
      ...draft.value,
      id: `task-${crypto.randomUUID()}`,
      title: toDuplicateTitle(draft.value.title),
      completed: false,
      updatedAt: new Date().toISOString()
    };

    if (googleSession) {
      const validTaskListIds = new Set(googleTaskLists.map((item) => item.id));
      const resolvedTaskListId = validTaskListIds.has(duplicatedTask.taskListId)
        ? duplicatedTask.taskListId
        : googleTaskLists[0]?.id ?? "";

      if (!resolvedTaskListId.trim()) {
        setStatus("No Google task list selected.");
        return;
      }

      setAuthBusy(true);
      try {
        const created = await createGoogleTask(
          resolvedTaskListId,
          duplicatedTask.title,
          duplicatedTask.due,
          duplicatedTask.notes
        );
        await refreshGoogleData();
        setSelection({ type: "task", id: created.id });
        setStatus("Duplicated Google task.");
        setDraft(null);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to duplicate Google task.");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    setTasks((current) => [...current, duplicatedTask].sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "")));
    setSelection({ type: "task", id: duplicatedTask.id });
    setStatus("Duplicated local task.");
    setDraft(null);
  };

  const openExistingTaskDraft = (task: GoogleTaskItem | TaskItem) => {
    setDraft({
      kind: "task",
      value: toEditableTaskDraft({
        ...task,
        due: getTaskDue(task),
        completed: isTaskCompleted(task)
      }),
      isNew: false
    });
  };

  const handleTaskItemClick = (task: GoogleTaskItem | TaskItem) => {
    setSelection({ type: "task", id: task.id });
  };

  const closeSelectionPanel = () => {
    setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
  };

  useEffect(() => {
    if (!draft) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraft(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [draft]);

  const deleteSelection = async () => {
    if (googleSession && selection?.type === "task") {
      const target = filteredDisplayedTasks.find((task) => task.id === selection.id);
      if (!target) {
        return;
      }
      if (target.taskListId === "google-tasks-calendar") {
        setStatus("This task is read-only calendar fallback data.");
        return;
      }

      setAuthBusy(true);
      try {
        await deleteGoogleTask(target.taskListId, selection.id);
        await refreshGoogleData();
        setStatus("Deleted Google task.");
        setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to delete Google task.");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    if (googleSession && selection?.type === "event") {
      setAuthBusy(true);
      try {
        const target = displayedEvents.find((event) => event.id === selection.id);
        await deleteGooglePrimaryEvent(selection.id, target?.calendarId ?? "primary");
        await refreshGoogleData();
        setStatus("Deleted Google event.");
        setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to delete Google event.");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    if (selection?.type === "event") {
      setEvents((current) => current.filter((item) => item.id !== selection.id));
      setStatus("Deleted local event.");
      setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
      return;
    }

    if (selection?.type === "task") {
      setTasks((current) => current.filter((item) => item.id !== selection.id));
      setStatus("Deleted local task.");
      setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
    }
  };

  const deleteDraft = async () => {
    if (!draft) {
      return;
    }

    if (draft.isNew) {
      setDraft(null);
      return;
    }

    if (draft.kind === "event") {
      if (googleSession) {
        setAuthBusy(true);
        try {
          await deleteGooglePrimaryEvent(draft.value.id, draft.value.calendarId || "primary");
          await refreshGoogleData();
          setStatus("Deleted Google event.");
          setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
          setDraft(null);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Failed to delete Google event.");
        } finally {
          setAuthBusy(false);
        }
        return;
      }

      setEvents((current) => current.filter((item) => item.id !== draft.value.id));
      setStatus("Deleted local event.");
      setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
      setDraft(null);
      return;
    }

    if (googleSession) {
      if (draft.value.taskListId === "google-tasks-calendar") {
        setStatus("This task is read-only calendar fallback data.");
        return;
      }

      setAuthBusy(true);
      try {
        await deleteGoogleTask(draft.value.taskListId, draft.value.id);
        await refreshGoogleData();
        setStatus("Deleted Google task.");
        setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
        setDraft(null);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to delete Google task.");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    setTasks((current) => current.filter((item) => item.id !== draft.value.id));
    setStatus("Deleted local task.");
    setSelection(selectedDate ? { type: "date", date: selectedDate } : null);
    setDraft(null);
  };

  const updateEventDate = async (eventId: string, start: string, end?: string) => {
    if (googleSession) {
      const original = displayedEvents.find((item) => item.id === eventId);
      if (!original) {
        return;
      }

      setAuthBusy(true);
      try {
        await upsertGooglePrimaryEvent({
          ...original,
          start,
          end: end ?? original.end
        });
        await refreshGoogleData();
        setStatus("Updated Google event timing.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to update Google event.");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    setEvents((current) =>
      current.map((item) =>
        item.id === eventId
          ? {
              ...item,
              start,
              end: end ?? item.end
            }
          : item
      )
    );
    setStatus("Updated local event timing.");
  };

  const handleDatesSet = (arg: DatesSetArg) => {
    const anchorDate = arg.startStr.slice(0, 10);
    setViewTitle(arg.view.title);
    if (selection?.type !== "event" && selection?.type !== "task") {
      setSelection({ type: "date", date: anchorDate });
    }
  };

  const navigateCalendar = (action: "today" | "prev" | "next") => {
    const api = calendarRef.current?.getApi();
    if (!api) {
      return;
    }

    if (action === "today") {
      api.today();
      return;
    }

    if (action === "prev") {
      api.prev();
      return;
    }

    api.next();
  };

  const miniCalendar = useMemo(() => {
    const year = miniCalendarCursor.getFullYear();
    const month = miniCalendarCursor.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const start = new Date(year, month, 1 - startOffset);

    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const iso = toLocalDateKey(date);
      return {
        iso,
        day: date.getDate(),
        inMonth: date.getMonth() === month
      };
    });
  }, [miniCalendarCursor]);

  const miniCalendarTitle = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric"
      }).format(miniCalendarCursor),
    [miniCalendarCursor]
  );

  const navigateMiniCalendar = (unit: "month" | "year", direction: -1 | 1) => {
    setMiniCalendarCursor((current) => {
      const next = new Date(current);
      if (unit === "year") {
        next.setFullYear(next.getFullYear() + direction);
      } else {
        next.setMonth(next.getMonth() + direction);
      }
      return new Date(next.getFullYear(), next.getMonth(), 1);
    });
  };

  const handleDateClick = (arg: DateClickArg) => {
    const clickedDate = arg.dateStr.slice(0, 10);
    setSelection({ type: "date", date: clickedDate });
    openNewEvent(clickedDate);
  };

  const handleEventClick = (arg: EventClickArg) => {
    const now = Date.now();
    const kind = arg.event.extendedProps.itemType as string | undefined;
    const taskId = (arg.event.extendedProps.taskId as string | undefined) ?? "";
    const logicalId = kind === "task" ? `task:${taskId}` : `event:${arg.event.id}`;
    const previous = lastEventClickRef.current;
    const isDoubleClick =
      !!previous && previous.id === logicalId && now - previous.ts < 350;
    lastEventClickRef.current = { id: logicalId, ts: now };

    if (kind === "task") {
      if (taskId) {
        setSelection({ type: "task", id: taskId });
        if (isDoubleClick) {
          const task = filteredDisplayedTasks.find((item) => item.id === taskId);
          if (task) {
            openExistingTaskDraft(task);
          }
        }
      }
      return;
    }
    setSelection({ type: "event", id: arg.event.id });
    if (isDoubleClick) {
      const event = displayedEvents.find((item) => item.id === arg.event.id);
      if (event) {
        setDraft({
          kind: "event",
          value: toEditableEventDraft(event),
          isNew: false
        });
      }
    }
  };

  const updateTaskDueDate = async (
    taskId: string,
    nextDue?: string,
    onErrorRevert?: () => void
  ) => {
    const original = filteredDisplayedTasks.find((task) => task.id === taskId);
    if (!original) {
      onErrorRevert?.();
      return;
    }

    if (googleSession) {
      if (original.taskListId === "google-tasks-calendar") {
        setStatus("This task is read-only calendar fallback data.");
        onErrorRevert?.();
        return;
      }
      if (!hasGoogleTasksWriteScope) {
        setGoogleTaskDueOverrides((current) => ({
          ...current,
          [taskId]: nextDue
        }));
        setStatus(
          "Moved in this app. Google sync for task date needs re-login with tasks write scope."
        );
        return;
      }
      setAuthBusy(true);
      try {
        const updated = await updateGoogleTaskDue(
          original.taskListId,
          original.id,
          nextDue
        );
        setGoogleTasks((current) =>
          current.map((task) => (task.id === updated.id ? updated : task))
        );
        setGoogleTaskDueOverrides((current) => {
          const next = { ...current };
          delete next[taskId];
          return next;
        });
        setStatus("Moved Google task date.");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to move Google task date.";
        if (
          /insufficient|scope|permission|403/i.test(message)
        ) {
          setGoogleTaskDueOverrides((current) => ({
            ...current,
            [taskId]: nextDue
          }));
          setStatus(
            "Moved in this app only. Google Tasks permission is insufficient; re-login to sync."
          );
        } else {
          setStatus(message);
          onErrorRevert?.();
        }
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    setTasks((current) =>
      current.map((task) =>
        task.id === original.id
          ? {
              ...task,
              due: nextDue,
              updatedAt: new Date().toISOString()
            }
          : task
      )
    );
    setStatus("Moved local task date.");
  };

  const handleEventDrop = (arg: EventDropArg) => {
    const kind = arg.event.extendedProps.itemType as string | undefined;
    if (kind === "task") {
      const taskId = (arg.event.extendedProps.taskId as string | undefined) ?? "";
      const droppedDate = extractDateOnly(arg.event.startStr) ?? extractDateOnly(arg.event.start?.toISOString());
      if (!taskId || !droppedDate) {
        arg.revert();
        return;
      }

      const original = filteredDisplayedTasks.find((task) => task.id === taskId);
      if (!original) {
        arg.revert();
        return;
      }
      void updateTaskDueDate(taskId, droppedDate, arg.revert);
      return;
    }

    const original = displayedEvents.find((item) => item.id === arg.event.id);
    const oldStart = arg.oldEvent.start;
    const newStart = arg.event.start;
    if (!original || !oldStart || !newStart) {
      arg.revert();
      return;
    }

    const dayDelta = Math.round(
      (newStart.getTime() - oldStart.getTime()) / (24 * 60 * 60 * 1000)
    );
    const nextStart = original.allDay
      ? shiftDateOnly(original.start.slice(0, 10), dayDelta)
      : shiftIsoKeepingClock(original.start, dayDelta);
    const nextEnd = original.allDay
      ? original.end
        ? shiftDateOnly(original.end.slice(0, 10), dayDelta)
        : undefined
      : original.end
      ? shiftIsoKeepingClock(original.end, dayDelta)
      : undefined;
    void updateEventDate(original.id, nextStart, nextEnd);
  };

  const handleEventResize = (arg: EventResizeDoneArg) => {
    const kind = arg.event.extendedProps.itemType as string | undefined;
    if (kind === "task") {
      arg.revert();
      return;
    }

    void updateEventDate(
      arg.event.id,
      arg.event.start?.toISOString() ?? new Date().toISOString(),
      arg.event.end?.toISOString()
    );
  };

  const toggleTaskCompleted = async (taskId: string, nextCompleted: boolean) => {
    const sourceTask = filteredDisplayedTasks.find((task) => task.id === taskId);
    const sourceCompleted = sourceTask?.completed ?? false;

    if (googleSession) {
      if (!sourceTask) {
        return;
      }
      if (sourceTask.taskListId === "google-tasks-calendar") {
        setGoogleTaskCompletionOverrides((current) => ({
          ...current,
          [taskId]: nextCompleted
        }));
        setStatus("This task is read-only calendar fallback data.");
        return;
      }

      setGoogleTaskCompletionOverrides((current) => {
        const next = { ...current };
        if (nextCompleted === sourceCompleted) {
          delete next[taskId];
        } else {
          next[taskId] = nextCompleted;
        }
        return next;
      });
      if (!hasGoogleTasksWriteScope) {
        setStatus("Moved in this app only. Re-login to sync task completion to Google.");
        return;
      }

      try {
        const updated = await updateGoogleTaskCompletion(
          sourceTask.taskListId,
          sourceTask.id,
          nextCompleted
        );
        setGoogleTasks((current) =>
          current.map((task) => (task.id === updated.id ? updated : task))
        );
        setGoogleTaskCompletionOverrides((current) => {
          const next = { ...current };
          delete next[taskId];
          return next;
        });
        setStatus("Synced task completion to Google.");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to sync task completion.";
        setStatus(message);
      }
      return;
    }

    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              completed: nextCompleted,
              updatedAt: new Date().toISOString()
            }
          : task
      )
    );
  };

  const renderCalendarEventContent = (arg: EventContentArg) => {
    const kind = arg.event.extendedProps.itemType as string | undefined;
    const completed = !!arg.event.extendedProps.taskCompleted;
    if (kind === "task") {
      const displayColor =
        (arg.event.extendedProps.displayColor as string | undefined) ?? "#8ab4f8";
      return (
        <label
          className="calendar-task-inline"
          onClick={(event) => {
            event.stopPropagation();
            const taskId = (arg.event.extendedProps.taskId as string | undefined) ?? "";
            if (!taskId) {
              return;
            }
            const task = filteredDisplayedTasks.find((item) => item.id === taskId);
            if (task) {
              handleTaskItemClick(task);
            }
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            const taskId = (arg.event.extendedProps.taskId as string | undefined) ?? "";
            if (!taskId) {
              return;
            }
            const task = filteredDisplayedTasks.find((item) => item.id === taskId);
            if (task) {
              openExistingTaskDraft(task);
            }
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={completed}
            style={{ accentColor: displayColor }}
            onChange={(event) => {
              event.stopPropagation();
              const taskId = (arg.event.extendedProps.taskId as string | undefined) ?? "";
              if (!taskId) {
                return;
              }
              void toggleTaskCompleted(taskId, event.target.checked);
            }}
          />
          <span
            className={clsx("calendar-task-title", { completed })}
            style={{ color: displayColor }}
          >
            {arg.event.title}
          </span>
        </label>
      );
    }
    const displayColor = arg.event.textColor || (arg.event.extendedProps.displayColor as string | undefined);
    return <span style={displayColor ? { color: displayColor } : undefined}>{arg.event.title}</span>;
  };

  const renderDetailPanel = () => {
    if (draft?.kind === "event") {
      return (
        <section className="detail-card">
          <div className="detail-header">
            <h2>{draft.isNew ? "New Event" : "Edit Event"}</h2>
            <button
              type="button"
              className="close-button"
              onClick={() => setDraft(null)}
              aria-label="Close dialog"
              title="Close"
            >
              ×
            </button>
          </div>
          <label>
            Title
            <input
              value={draft.value.title}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: { ...draft.value, title: event.target.value }
                })
              }
            />
          </label>
          <label>
            Start
            <input
              type="datetime-local"
              value={toDateTimeLocalInput(draft.value.start)}
              {...getDateTimeInputBounds(draft.value.start)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: {
                    ...draft.value,
                    start: fromDateTimeLocalInput(event.target.value, draft.value.start)
                  }
                })
              }
            />
          </label>
          <label>
            End
            <input
              type="datetime-local"
              value={toDateTimeLocalInput(draft.value.end)}
              {...getDateTimeInputBounds(draft.value.end)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: {
                    ...draft.value,
                    end: fromDateTimeLocalInput(event.target.value, draft.value.end)
                  }
                })
              }
            />
          </label>
          <label>
            Calendar
            <select
              value={draft.value.calendarId}
              onChange={(event) => {
                const selectedCalendarId = event.target.value;
                const selectedCalendarColor =
                  eventDraftCalendars.find((item) => item.id === selectedCalendarId)?.color ??
                  draft.value.color;
                setDraft({
                  ...draft,
                  value: {
                    ...draft.value,
                    calendarId: selectedCalendarId,
                    color: selectedCalendarColor
                  }
                });
              }}
            >
              {eventDraftCalendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Add location
            <div className="input-action-row">
              <input
                value={draft.value.location ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    value: { ...draft.value, location: event.target.value }
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => void openDraftLocationInMaps()}
                disabled={saveBusy || authBusy}
                aria-label="Open location in Google Maps"
                title="Open in Google Maps"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 21s-5.5-5.6-5.5-10A5.5 5.5 0 1 1 17.5 11c0 4.4-5.5 10-5.5 10Z" />
                  <circle cx="12" cy="11" r="2.4" />
                </svg>
              </button>
            </div>
          </label>
          <label>
            Add guests
            <input
              placeholder="name@example.com, name2@example.com"
              value={(draft.value.guests ?? []).join(", ")}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: {
                    ...draft.value,
                    guests: event.target.value
                      .split(/[,\n;]/)
                      .map((item) => item.trim())
                      .filter(Boolean)
                  }
                })
              }
            />
          </label>
          <label>
            Description
            <textarea
              rows={4}
              value={draft.value.description ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: { ...draft.value, description: event.target.value }
                })
              }
            />
          </label>
          <div className="panel-actions">
            <button className="primary" onClick={() => void saveDraft()} disabled={saveBusy || authBusy}>
              Save
            </button>
            {!draft.isNew ? (
              <button onClick={() => void duplicateDraft()} disabled={saveBusy || authBusy}>
                Duplicate
              </button>
            ) : null}
            {!draft.isNew ? (
              <button onClick={() => void deleteDraft()} disabled={saveBusy || authBusy}>
                Delete
              </button>
            ) : null}
            <button onClick={() => setDraft(null)} disabled={saveBusy || authBusy}>Cancel</button>
          </div>
        </section>
      );
    }

    if (draft?.kind === "task") {
      return (
        <section className="detail-card">
          <div className="detail-header">
            <h2>{draft.isNew ? "New Task" : "Edit Task"}</h2>
            <button
              type="button"
              className="close-button"
              onClick={() => setDraft(null)}
              aria-label="Close dialog"
              title="Close"
            >
              ×
            </button>
          </div>
          <label>
            Title
            <input
              value={draft.value.title}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: { ...draft.value, title: event.target.value }
                })
              }
            />
          </label>
          <label>
            Due Date
            <input
              type="date"
              value={draft.value.due ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: { ...draft.value, due: event.target.value || undefined }
                })
              }
            />
          </label>
          <label>
            Task list
            <select
              value={draft.value.taskListId}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: { ...draft.value, taskListId: event.target.value }
                })
              }
            >
              {taskDraftLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Notes
            <textarea
              rows={5}
              value={draft.value.notes}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: { ...draft.value, notes: event.target.value }
                })
              }
            />
          </label>
          <div className="panel-actions">
            <button className="primary" onClick={() => void saveDraft()} disabled={saveBusy || authBusy}>
              Save
            </button>
            {!draft.isNew ? (
              <button onClick={() => void duplicateDraft()} disabled={saveBusy || authBusy}>
                Duplicate
              </button>
            ) : null}
            {!draft.isNew ? (
              <button onClick={() => void deleteDraft()} disabled={saveBusy || authBusy}>
                Delete
              </button>
            ) : null}
            <button onClick={() => setDraft(null)} disabled={saveBusy || authBusy}>Cancel</button>
          </div>
        </section>
      );
    }

    if (selectedEvent) {
      const isGoogleEvent = googleSession && googleEvents.some((event) => event.id === selectedEvent.id);
      return (
        <section className="detail-card">
          <div className="detail-header">
            <h2>{selectedEvent.title}</h2>
            <button
              type="button"
              className="close-button"
              onClick={closeSelectionPanel}
              aria-label="Close details"
              title="Close"
            >
              ×
            </button>
          </div>
          <p>{formatDateTimeLabel(selectedEvent.start)}</p>
          <p>{selectedEvent.description || "No description."}</p>
          <div className="detail-inline-row">
            <p>{selectedEvent.location || "No location."}</p>
            <button
              type="button"
              className="icon-button"
              onClick={() => void openEventLocationInMaps(selectedEvent)}
              aria-label="Open event location in Google Maps"
              title="Open in Google Maps"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 21s-5.5-5.6-5.5-10A5.5 5.5 0 1 1 17.5 11c0 4.4-5.5 10-5.5 10Z" />
                <circle cx="12" cy="11" r="2.4" />
              </svg>
            </button>
          </div>
          <div className="panel-actions">
            <button
              className="primary"
              onClick={() =>
                setDraft({
                  kind: "event",
                  value: toEditableEventDraft(selectedEvent),
                  isNew: false
                })
              }
            >
              Edit
            </button>
            <button onClick={() => void deleteSelection()}>Delete</button>
          </div>
        </section>
      );
    }

    if (selectedTask) {
      const isGoogleTask = googleSession && googleTasks.some((task) => task.id === selectedTask.id);
      const selectedTaskDue = getTaskDue(selectedTask);
      const selectedTaskLocation = getTaskLocation(selectedTask);
      return (
        <section className="detail-card">
          <div className="detail-header">
            <h2 className={clsx({ "task-completed": isTaskCompleted(selectedTask) })}>
              {selectedTask.title}
            </h2>
            <button
              type="button"
              className="close-button"
              onClick={closeSelectionPanel}
              aria-label="Close details"
              title="Close"
            >
              ×
            </button>
          </div>
          <p>{selectedTaskDue ? formatDateLabel(selectedTaskDue) : "No due date"}</p>
          <p>{selectedTask.notes || "No notes."}</p>
          {selectedTaskLocation ? (
            <div className="detail-inline-row">
              <p>{selectedTaskLocation}</p>
              <button
                type="button"
                className="icon-button"
                onClick={() => void openTaskLocationInMaps(selectedTask)}
                aria-label="Open task location in Google Maps"
                title="Open in Google Maps"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 21s-5.5-5.6-5.5-10A5.5 5.5 0 1 1 17.5 11c0 4.4-5.5 10-5.5 10Z" />
                  <circle cx="12" cy="11" r="2.4" />
                </svg>
              </button>
            </div>
          ) : null}
          <div className="panel-actions">
            <button
              className={clsx({ primary: !isTaskCompleted(selectedTask) })}
              onClick={() => void toggleTaskCompleted(selectedTask.id, !isTaskCompleted(selectedTask))}
            >
              {isTaskCompleted(selectedTask) ? "Mark Open" : "Mark Done"}
            </button>
            {!isGoogleTask ? (
              <button
                className={clsx({ primary: isTaskCompleted(selectedTask) })}
                onClick={() => openExistingTaskDraft(selectedTask)}
              >
                Edit
              </button>
            ) : null}
            <button
              onClick={() => void deleteSelection()}
              disabled={selectedTask.taskListId === "google-tasks-calendar"}
            >
              Delete
            </button>
          </div>
        </section>
      );
    }

    const dayEvents = displayedEvents.filter(
      (event) => selectedDate && isSameDate(event.start, selectedDate)
    );

    return (
      <section className="detail-card">
        <h2>{selectedDate ? formatDateLabel(selectedDate) : "Pick a date"}</h2>
        <p>Calendar events and tasks for the selected date appear here.</p>
        <div className="stack-list">
          {dayEvents.map((event) => (
            <button
              key={event.id}
              className="list-row"
              onClick={() => setSelection({ type: "event", id: event.id })}
              onDoubleClick={() =>
                setDraft({
                  kind: "event",
                  value: toEditableEventDraft(event),
                  isNew: false
                })
              }
            >
              <span style={{ color: getEventColor(event) }}>{event.title}</span>
              <small>{formatDateTimeLabel(event.start)}</small>
            </button>
          ))}
          {dayTasks.map((task) => (
            <div
              key={task.id}
              className="list-row task-row"
              onClick={() => handleTaskItemClick(task)}
              onDoubleClick={() => openExistingTaskDraft(task)}
            >
              <input
                type="checkbox"
                checked={isTaskCompleted(task)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onChange={(event) => void toggleTaskCompleted(task.id, event.target.checked)}
              />
              <button
                type="button"
                onClick={() => setSelection({ type: "task", id: task.id })}
                onDoubleClick={() => openExistingTaskDraft(task)}
              >
                <span className={clsx({ "task-completed": isTaskCompleted(task) })}>
                  {task.title}
                </span>
              </button>
              <small>{isTaskCompleted(task) ? "Done" : "Todo"}</small>
            </div>
          ))}
          {dayEvents.length === 0 && dayTasks.length === 0 ? (
            <p className="muted">Nothing is scheduled for this date.</p>
          ) : null}
        </div>
      </section>
    );
  };

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand-row">
          <h1>Desk Calendar</h1>
        </div>

        <section className="side-section">
          <div className="mini-calendar-header">
            <h2>{miniCalendarTitle}</h2>
            <div className="mini-calendar-nav" aria-label="Mini calendar navigation">
              <button type="button" onClick={() => navigateMiniCalendar("year", -1)}>
                &lt;&lt;
              </button>
              <button type="button" onClick={() => navigateMiniCalendar("month", -1)}>
                &lt;
              </button>
              <button type="button" onClick={() => navigateMiniCalendar("month", 1)}>
                &gt;
              </button>
              <button type="button" onClick={() => navigateMiniCalendar("year", 1)}>
                &gt;&gt;
              </button>
            </div>
          </div>
          <div className="mini-weekdays">
            {["S", "M", "T", "W", "T", "F", "S"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="mini-grid">
            {miniCalendar.map((item) => (
              <button
                key={item.iso}
                className={clsx("mini-day", {
                  "out-month": !item.inMonth,
                  selected: selectedDate === item.iso
                })}
                onClick={() => setSelection({ type: "date", date: item.iso })}
              >
                {item.day}
              </button>
            ))}
          </div>
        </section>

        <section className="side-section">
          <h2>Google Account</h2>
          {googleSession ? (
            <>
              <div className="account-pill">
                <span className="account-label">Signed In</span>
                <strong>{googleSession.email ?? googleSession.name ?? "Google User"}</strong>
              </div>
              <div className="quick-actions">
                <button onClick={handleGoogleRefresh} disabled={authBusy}>
                  Refresh
                </button>
                <button onClick={handleGoogleSignOut} disabled={authBusy}>
                  Sign Out
                </button>
              </div>
            </>
          ) : (
            <div className="quick-actions">
              <button
                className="primary"
                onClick={handleGoogleSignIn}
                disabled={authBusy}
              >
                {authBusy ? "Signing In..." : "Google Sign In"}
              </button>
              <button disabled>Refresh</button>
            </div>
          )}
        </section>

        <section className="side-section">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setMyCalendarsCollapsed((value) => !value)}
          >
            <h2>My calendars</h2>
            <span aria-hidden>{myCalendarsCollapsed ? "v" : "^"}</span>
          </button>
          {!myCalendarsCollapsed ? calendarOptions.map((calendar) => {
            const checked = visibleCalendarIds.includes(calendar.id);
            return (
              <div
                key={calendar.id}
                className="calendar-check-row"
                style={{ ["--calendar-color" as string]: calendar.color }}
              >
                <label className="calendar-check-main">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const nextChecked = event.target.checked;
                      setVisibleCalendarIds((current) => {
                        if (nextChecked) {
                          return current.includes(calendar.id)
                            ? current
                            : [...current, calendar.id];
                        }
                        return current.filter((id) => id !== calendar.id);
                      });

                    }}
                  />
                  <span className="swatch" style={{ backgroundColor: calendar.color }} />
                  <span>{calendar.label}</span>
                </label>
                <input
                  type="color"
                  className="calendar-color-input"
                  aria-label={`${calendar.label} color`}
                  value={calendar.color}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const nextColor = event.target.value;
                    setSettings((current) => ({
                      ...current,
                      calendarColorOverrides: {
                        ...(current.calendarColorOverrides ?? {}),
                        [calendar.id]: nextColor
                      }
                    }));
                  }}
                />
              </div>
            );
          }) : null}
          {!myCalendarsCollapsed && calendarOptions.length === 0 ? (
            <p className="muted">No calendars loaded yet.</p>
          ) : null}
        </section>

      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="toolbar-left">
            <div className="segmented">
              <button onClick={() => navigateCalendar("today")}>Today</button>
              <button onClick={() => navigateCalendar("prev")}>{"<"}</button>
              <button onClick={() => navigateCalendar("next")}>{">"}</button>
            </div>
            <h2 className="toolbar-title">{viewTitle}</h2>
          </div>
          <div className="segmented">
            <button
              className={clsx({ active: viewMode === "dayGridMonth" })}
              onClick={() => setViewMode("dayGridMonth")}
            >
              Month
            </button>
            <button
              className={clsx({ active: viewMode === "timeGridWeek" })}
              onClick={() => setViewMode("timeGridWeek")}
            >
              Week
            </button>
            <button
              className={clsx({ active: viewMode === "timeGridDay" })}
              onClick={() => setViewMode("timeGridDay")}
            >
              Day
            </button>
          </div>
        </header>
        <div className="calendar-card">
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView={viewMode}
            headerToolbar={false}
            height="auto"
            slotMinTime={CALENDAR_SLOT_MIN_TIME}
            slotMaxTime={CALENDAR_SLOT_MAX_TIME}
            businessHours={{
              startTime: CALENDAR_SLOT_MIN_TIME,
              endTime: CALENDAR_SLOT_MAX_TIME
            }}
            editable
            selectable
            datesSet={handleDatesSet}
            dateClick={handleDateClick}
            eventClick={handleEventClick}
            eventDrop={handleEventDrop}
            eventResize={handleEventResize}
              eventContent={renderCalendarEventContent}
              events={[
                ...displayedEvents.map((event) => ({
                  ...event,
                  editable: true,
                  backgroundColor: hexToRgba(getEventColor(event), 0.22),
                  borderColor: getEventColor(event),
                  textColor: getEventColor(event),
                  extendedProps: {
                    itemType: "event",
                    displayColor: getEventColor(event)
                  }
                })),
              ...calendarTaskEntries
            ]} 
          />
        </div>

        <section className="upcoming-grid">
          <div className="upcoming-card">
            <h2>예정 작업 및 일정</h2>
            <div className="stack-list upcoming-list">
              {scheduleItems.map((item) =>
                item.type === "event" ? (
                  <button
                    key={item.id}
                    className={clsx("list-row", { "past-row": item.isPast })}
                    onClick={() => setSelection({ type: "event", id: item.event.id })}
                    onDoubleClick={() =>
                      setDraft({
                        kind: "event",
                        value: toEditableEventDraft(item.event),
                        isNew: false
                      })
                    }
                  >
                    <span className={clsx({ "past-text": item.isPast })} style={{ color: item.isPast ? undefined : item.color }}>
                      {item.event.title}
                    </span>
                    <small className={clsx({ "past-text": item.isPast })}>
                      {formatDateTimeLabel(item.event.start)}
                    </small>
                  </button>
                ) : (
                  <div
                    key={item.id}
                    className={clsx("list-row", "task-row", { "past-row": item.isPast })}
                    onClick={() => handleTaskItemClick(item.task)}
                    onDoubleClick={() => openExistingTaskDraft(item.task)}
                  >
                    <input
                      type="checkbox"
                      checked={isTaskCompleted(item.task)}
                      style={{ accentColor: item.isPast ? "#d85b66" : item.color }}
                      onClick={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        void toggleTaskCompleted(item.task.id, event.target.checked)
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setSelection({ type: "task", id: item.task.id })}
                      onDoubleClick={() => openExistingTaskDraft(item.task)}
                    >
                      <span
                        className={clsx({
                          "task-completed": isTaskCompleted(item.task),
                          "past-text": item.isPast
                        })}
                        style={{ color: item.isPast ? undefined : item.color }}
                      >
                        {item.task.title}
                      </span>
                    </button>
                    <small className={clsx({ "past-text": item.isPast })}>
                      {(() => {
                        const due = getTaskDue(item.task);
                        return due ? formatDateLabel(due) : "No due";
                      })()}
                    </small>
                  </div>
                )
              )}
              {scheduleItems.length === 0 ? (
                <p className="muted">예정 작업 및 일정이 없습니다.</p>
              ) : null}
            </div>
          </div>
        </section>
      </section>
      {draft ? (
        <div className="modal-backdrop" onMouseDown={() => setDraft(null)}>
          <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
            {draft.isNew ? (
              <div className="draft-tabs">
                <button
                  className={clsx({ active: draft.kind === "event" })}
                  onClick={() => switchDraftKind("event")}
                >
                  New Event
                </button>
                <button
                  className={clsx({ active: draft.kind === "task" })}
                  onClick={() => switchDraftKind("task")}
                >
                  New Task
                </button>
              </div>
            ) : null}
            {renderDetailPanel()}
          </div>
        </div>
      ) : null}
      <div className="app-version-badge" aria-label={`App version ${APP_VERSION}`}>
        v{APP_VERSION}
      </div>
    </main>
  );
}

export default App;

