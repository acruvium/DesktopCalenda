import { invoke } from "@tauri-apps/api/core";
import type {
  CalendarEvent,
  GoogleCalendarEvent,
  GoogleCalendarListEntry,
  GoogleTaskItem,
  GoogleTaskListEntry,
  GoogleSession
} from "../types";

const toErrorMessage = (error: unknown): string => {
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
      // Ignore serialization errors and use fallback.
    }
  }

  return "Desktop command failed.";
};

const withTimeout = async <T,>(promise: Promise<T>, ms = 10000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("The desktop command timed out."));
        }, ms);
      })
    ]);
  } catch (error) {
    throw new Error(toErrorMessage(error));
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export const googleSignIn = async (
  clientId: string,
  allowInsecureTls = false,
  clientSecret?: string
) => {
  // Let the Rust command control OAuth timeout to avoid front-end premature failures.
  try {
    return await invoke<GoogleSession>("google_sign_in", {
      clientId,
      allowInsecureTls,
      clientSecret
    });
  } catch (error) {
    throw new Error(toErrorMessage(error));
  }
};

export const googleSignOut = async () => {
  return withTimeout(invoke("google_sign_out"), 8000);
};

export const googleRestoreSession = async () => {
  return withTimeout(invoke<GoogleSession | null>("google_restore_session"), 5000);
};

export const fetchGoogleCalendarList = async () => {
  return withTimeout(
    invoke<GoogleCalendarListEntry[]>("google_fetch_calendar_list"),
    10000
  );
};

export const googleSetCalendarSelected = async (
  calendarId: string,
  selected: boolean
) => {
  return withTimeout(
    invoke<GoogleCalendarListEntry>("google_set_calendar_selected", {
      calendarId,
      selected
    }),
    10000
  );
};

export const fetchGooglePrimaryEvents = async (
  timeMin?: string,
  timeMax?: string
) => {
  return withTimeout(
    invoke<GoogleCalendarEvent[]>("google_fetch_primary_events", {
      timeMin,
      timeMax
    }),
    10000
  );
};

export const fetchGoogleTaskLists = async () => {
  return withTimeout(
    invoke<GoogleTaskListEntry[]>("google_fetch_task_lists"),
    10000
  );
};

export const fetchGoogleTasks = async () => {
  return withTimeout(invoke<GoogleTaskItem[]>("google_fetch_tasks"), 12000);
};

export const updateGoogleTaskDue = async (
  taskListId: string,
  taskId: string,
  due?: string
) => {
  return withTimeout(
    invoke<GoogleTaskItem>("google_update_task_due", {
      taskListId,
      taskId,
      due
    }),
    12000
  );
};

export const updateGoogleTaskCompletion = async (
  taskListId: string,
  taskId: string,
  completed: boolean
) => {
  return withTimeout(
    invoke<GoogleTaskItem>("google_update_task_completion", {
      taskListId,
      taskId,
      completed
    }),
    12000
  );
};

export const createGoogleTask = async (
  taskListId: string,
  title: string,
  due?: string,
  notes?: string
) => {
  return withTimeout(
    invoke<GoogleTaskItem>("google_create_task", {
      taskListId,
      title,
      due,
      notes
    }),
    12000
  );
};

export const updateGoogleTask = async (
  taskListId: string,
  taskId: string,
  title: string,
  due?: string,
  notes?: string
) => {
  return withTimeout(
    invoke<GoogleTaskItem>("google_update_task", {
      taskListId,
      taskId,
      title,
      due,
      notes
    }),
    12000
  );
};

export const deleteGoogleTask = async (
  taskListId: string,
  taskId: string
) => {
  return withTimeout(
    invoke("google_delete_task", {
      taskListId,
      taskId
    }),
    10000
  );
};

export const upsertGooglePrimaryEvent = async (event: CalendarEvent) => {
  return withTimeout(
    invoke<GoogleCalendarEvent>("google_upsert_primary_event", { event }),
    12000
  );
};

export const deleteGooglePrimaryEvent = async (
  eventId: string,
  calendarId = "primary"
) => {
  return withTimeout(
    invoke("google_delete_primary_event", { eventId, calendarId }),
    10000
  );
};
