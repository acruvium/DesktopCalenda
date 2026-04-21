use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{distributions::Alphanumeric, Rng};
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use url::Url;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_FALLBACK_URL: &str = "https://www.googleapis.com/oauth2/v4/token";
const GOOGLE_USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_CALENDAR_LIST_URL: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const GOOGLE_TASK_LISTS_URL: &str = "https://tasks.googleapis.com/tasks/v1/users/@me/lists";

const GOOGLE_SCOPES: [&str; 5] = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
    "openid",
    "email",
    "profile",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockSettings {
    pub dock_mode: bool,
    pub dock_side: String,
    pub always_on_top: bool,
    pub launch_in_dock_mode: bool,
    pub remember_window_state: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowStateSnapshot {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSession {
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarListEntry {
    pub id: String,
    pub summary: String,
    pub primary: bool,
    pub selected: bool,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
    pub access_role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub start: String,
    pub end: Option<String>,
    pub all_day: bool,
    pub description: Option<String>,
    pub location: Option<String>,
    pub guests: Option<Vec<String>>,
    pub color: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleTaskListEntry {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleTaskItem {
    pub id: String,
    pub task_list_id: String,
    pub title: String,
    pub due: Option<String>,
    pub notes: Option<String>,
    pub completed: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    scopes: Vec<String>,
    #[serde(default)]
    allow_insecure_tls: bool,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleUserInfo {
    email: Option<String>,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCalendarListResponse {
    items: Option<Vec<GoogleCalendarListItem>>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCalendarListItem {
    id: String,
    summary: Option<String>,
    deleted: Option<bool>,
    primary: Option<bool>,
    selected: Option<bool>,
    color_id: Option<String>,
    background_color: Option<String>,
    foreground_color: Option<String>,
    access_role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleColorsResponse {
    #[serde(default)]
    calendar: HashMap<String, GoogleColorPaletteEntry>,
}

#[derive(Debug, Deserialize)]
struct GoogleColorPaletteEntry {
    background: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventsResponse {
    items: Option<Vec<GoogleEventItem>>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventItem {
    id: String,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    attendees: Option<Vec<GoogleEventAttendee>>,
    start: GoogleDateTime,
    end: Option<GoogleDateTime>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventAttendee {
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleDateTime {
    date: Option<String>,
    date_time: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarEventInput {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub description: Option<String>,
    pub location: Option<String>,
    pub guests: Option<Vec<String>>,
    pub color: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventWriteBody {
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attendees: Option<Vec<GoogleEventAttendeeWrite>>,
    start: GoogleEventDateTimeWrite,
    end: GoogleEventDateTimeWrite,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventAttendeeWrite {
    email: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventDateTimeWrite {
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    #[serde(rename = "dateTime", skip_serializing_if = "Option::is_none")]
    date_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleTaskListsResponse {
    items: Option<Vec<GoogleTaskListItem>>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleTaskListItem {
    id: String,
    title: String,
}

#[derive(Debug, Deserialize)]
struct GoogleTasksResponse {
    items: Option<Vec<GoogleTask>>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleTask {
    id: String,
    title: Option<String>,
    notes: Option<String>,
    due: Option<String>,
    status: Option<String>,
    completed: Option<String>,
    updated: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleTaskPatchBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    due: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleTaskStatusPatchBody {
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleTaskCreateBody {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    due: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleTaskUpdateBody {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    due: Option<String>,
}

#[derive(Default)]
pub struct WindowStateStore(Mutex<Option<WindowStateSnapshot>>);

#[derive(Default)]
pub struct GoogleAuthStore(Mutex<Option<GoogleTokens>>);

mod commands {
    use super::*;

    #[tauri::command]
    pub async fn apply_dock_settings(
        app: AppHandle,
        window: Window,
        state: State<'_, WindowStateStore>,
        settings: DockSettings,
    ) -> Result<serde_json::Value, String> {
        if settings.remember_window_state {
            let size = window.outer_size().map_err(|error| error.to_string())?;
            let position = window.outer_position().map_err(|error| error.to_string())?;

            let snapshot = WindowStateSnapshot {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            };

            if let Ok(mut guard) = state.0.lock() {
                *guard = Some(snapshot);
            }
        }

        if settings.dock_mode {
            window
                .set_decorations(false)
                .map_err(|error| error.to_string())?;
            window
                .set_always_on_top(settings.always_on_top)
                .map_err(|error| error.to_string())?;
        } else {
            window
                .set_decorations(true)
                .map_err(|error| error.to_string())?;
            window
                .set_always_on_top(false)
                .map_err(|error| error.to_string())?;
        }

        #[cfg(target_os = "windows")]
        super::apply_windows_dock_mode(&window, &settings)?;

        #[cfg(target_os = "macos")]
        super::apply_macos_window_mode(&window, &settings)?;

        let _ = app.emit("dock-settings-applied", &settings);

        Ok(serde_json::json!({
            "applied": true,
            "platform": std::env::consts::OS,
            "dockMode": settings.dock_mode
        }))
    }

    #[tauri::command]
    pub fn load_window_state(state: State<'_, WindowStateStore>) -> Option<WindowStateSnapshot> {
        state.0.lock().ok().and_then(|guard| guard.clone())
    }

    #[tauri::command]
    pub fn open_external_url(url: String) -> Result<(), String> {
        let parsed = Url::parse(url.trim()).map_err(|_| "Invalid external URL.".to_string())?;
        match parsed.scheme() {
            "http" | "https" => super::open_external_url_impl(parsed.as_str()),
            _ => Err("Only http and https URLs are allowed.".to_string()),
        }
    }

    #[tauri::command]
    pub async fn google_sign_in(
        app: AppHandle,
        state: State<'_, GoogleAuthStore>,
        client_id: String,
        client_secret: Option<String>,
        allow_insecure_tls: Option<bool>,
    ) -> Result<GoogleSession, String> {
        let client_id = client_id.trim().to_string();
        if client_id.is_empty() {
            return Err("Google OAuth client ID is required.".to_string());
        }
        let allow_insecure_tls = allow_insecure_tls.unwrap_or(false);

        let client_secret = client_secret
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let auth = perform_google_oauth(client_id, client_secret, allow_insecure_tls)
            .await
            .map_err(|error| format!("OAuth flow failed: {error}"))?;
        let session = fetch_google_user_info(
            &auth.access_token,
            &auth.scopes,
            allow_insecure_tls,
        )
            .await
            .map_err(|error| format!("Failed to fetch Google user profile: {error}"))?;

        store_google_tokens(&app, &auth)
            .map_err(|error| format!("Failed to persist Google tokens: {error}"))?;
        let mut guard = state.0.lock().map_err(|_| "Failed to store auth state.".to_string())?;
        *guard = Some(auth);

        Ok(session)
    }

    #[tauri::command]
    pub fn google_sign_out(app: AppHandle, state: State<'_, GoogleAuthStore>) -> Result<(), String> {
        let mut guard = state.0.lock().map_err(|_| "Failed to clear auth state.".to_string())?;
        *guard = None;
        clear_google_tokens(&app)?;
        Ok(())
    }

    #[tauri::command]
    pub async fn google_restore_session(
        app: AppHandle,
        state: State<'_, GoogleAuthStore>,
    ) -> Result<Option<GoogleSession>, String> {
        let Some(tokens) = load_google_tokens(&app)? else {
            return Ok(None);
        };

        {
            let mut guard = state.0.lock().map_err(|_| "Failed to restore auth state.".to_string())?;
            *guard = Some(tokens);
        }

        let access_token = ensure_access_token(state).await?;
        let guard = app.state::<GoogleAuthStore>();
        let (scopes, allow_insecure_tls) = {
            let locked = guard
                .0
                .lock()
                .map_err(|_| "Failed to read restored scopes.".to_string())?;
            let maybe = locked.as_ref();
            (
                maybe.map(|tokens| tokens.scopes.clone()).unwrap_or_default(),
                maybe.map(|tokens| tokens.allow_insecure_tls).unwrap_or(false),
            )
        };
        let session =
            fetch_google_user_info(&access_token, &scopes, allow_insecure_tls).await?;
        Ok(Some(session))
    }

    #[tauri::command]
    pub async fn google_fetch_calendar_list(
        state: State<'_, GoogleAuthStore>,
    ) -> Result<Vec<GoogleCalendarListEntry>, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };
        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;
        let items = fetch_all_calendar_list_items(&client, &access_token).await?;
        let color_map = fetch_calendar_color_map(&client, &access_token)
            .await
            .unwrap_or_default();
        Ok(items
            .into_iter()
            .filter(|item| !item.deleted.unwrap_or(false))
            .map(|item| {
                let id = item.id;
                let summary = item.summary.unwrap_or_else(|| "(deleted calendar)".to_string());
                let by_id = item
                    .color_id
                    .as_ref()
                    .and_then(|color_id| color_map.get(color_id).cloned());
                let background_color = if is_task_like_calendar(id.as_str(), summary.as_str()) {
                    by_id.or(item.background_color.clone())
                } else {
                    item.background_color.clone().or(by_id)
                };

                GoogleCalendarListEntry {
                    id,
                    summary,
                    primary: item.primary.unwrap_or(false),
                    selected: item.selected.unwrap_or(false),
                    background_color,
                    foreground_color: item.foreground_color,
                    access_role: item.access_role,
                }
            })
            .collect())
    }

    #[tauri::command]
    pub async fn google_fetch_primary_events(
        state: State<'_, GoogleAuthStore>,
        time_min: Option<String>,
        time_max: Option<String>,
    ) -> Result<Vec<GoogleCalendarEvent>, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };
        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;
        let color_map = fetch_calendar_color_map(&client, &access_token)
            .await
            .unwrap_or_default();
        let calendar_list = fetch_all_calendar_list_items(&client, &access_token).await?;
        let mut events = Vec::new();

        for calendar in calendar_list {
            let mut page_token: Option<String> = None;

            loop {
                let mut url = Url::parse("https://www.googleapis.com/calendar/v3/calendars")
                    .map_err(|error| error.to_string())?;
                {
                    let mut segments = url
                        .path_segments_mut()
                        .map_err(|_| "Failed to build Google events URL.".to_string())?;
                    segments.push(&calendar.id);
                    segments.push("events");
                }
                {
                    let mut query = url.query_pairs_mut();
                    query.append_pair("singleEvents", "true");
                    query.append_pair("orderBy", "startTime");
                    query.append_pair("maxResults", "250");
                    if let Some(value) = time_min.as_deref() {
                        query.append_pair("timeMin", value);
                    }
                    if let Some(value) = time_max.as_deref() {
                        query.append_pair("timeMax", value);
                    }
                    if let Some(token) = page_token.as_deref() {
                        query.append_pair("pageToken", token);
                    }
                }

                let response = client
                    .get(url)
                    .bearer_auth(&access_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?;
                let response = parse_json_response::<GoogleEventsResponse>(
                    response,
                    "google events list request",
                )
                .await?;

                let calendar_color = calendar
                    .background_color
                    .clone()
                    .or_else(|| calendar.color_id.as_ref().and_then(|id| color_map.get(id).cloned()));

                if let Some(items) = response.items {
                    events.extend(
                        items
                            .into_iter()
                            .map(|item| {
                                google_event_item_to_event(
                                    item,
                                    calendar.id.clone(),
                                    calendar_color.clone(),
                                )
                            }),
                    );
                }

                page_token = response.next_page_token;
                if page_token.is_none() {
                    break;
                }
            }
        }

        Ok(events)
    }

    #[tauri::command]
    pub async fn google_set_calendar_selected(
        state: State<'_, GoogleAuthStore>,
        calendar_id: String,
        selected: bool,
    ) -> Result<GoogleCalendarListEntry, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };
        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;
        let color_map = fetch_calendar_color_map(&client, &access_token)
            .await
            .unwrap_or_default();

        let mut url = Url::parse(GOOGLE_CALENDAR_LIST_URL).map_err(|error| error.to_string())?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Failed to build Google calendar list URL.".to_string())?;
            segments.push(calendar_id.as_str());
        }

        let body = serde_json::json!({
            "selected": selected
        });

        let response = client
            .patch(url)
            .bearer_auth(&access_token)
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let item = parse_json_response::<GoogleCalendarListItem>(
            response,
            "google calendar selected patch",
        )
        .await?;

        let id = item.id;
        let summary = item.summary.unwrap_or_else(|| "(deleted calendar)".to_string());
        let by_id = item
            .color_id
            .as_ref()
            .and_then(|color_id| color_map.get(color_id).cloned());
        let background_color = if is_task_like_calendar(id.as_str(), summary.as_str()) {
            by_id.or(item.background_color.clone())
        } else {
            item.background_color.clone().or(by_id)
        };

        Ok(GoogleCalendarListEntry {
            id,
            summary,
            primary: item.primary.unwrap_or(false),
            selected: item.selected.unwrap_or(selected),
            background_color,
            foreground_color: item.foreground_color,
            access_role: item.access_role,
        })
    }

    #[tauri::command]
    pub async fn google_upsert_primary_event(
        state: State<'_, GoogleAuthStore>,
        event: GoogleCalendarEventInput,
    ) -> Result<GoogleCalendarEvent, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };
        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;

        let body = GoogleEventWriteBody {
            summary: event.title.trim().to_string(),
            description: event.description.filter(|value| !value.trim().is_empty()),
            location: event.location.filter(|value| !value.trim().is_empty()),
            attendees: event.guests.and_then(|items| {
                let guests = items
                    .into_iter()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .map(|email| GoogleEventAttendeeWrite { email })
                    .collect::<Vec<_>>();
                if guests.is_empty() {
                    None
                } else {
                    Some(guests)
                }
            }),
            start: to_google_event_time(event.start.as_str(), event.all_day),
            end: to_google_event_time(event.end.as_str(), event.all_day),
        };

        let calendar_id = if event.calendar_id.trim().is_empty() {
            "primary".to_string()
        } else {
            event.calendar_id.clone()
        };
        let events_url = google_calendar_events_url(&calendar_id)?;
        let is_new_event = event.id.trim().is_empty() || event.id.starts_with("event-");
        let request = if is_new_event {
            client
                .post(events_url.clone())
                .bearer_auth(&access_token)
                .json(&body)
        } else {
            let url = format!("{}/{}", events_url, event.id);
            client.patch(url).bearer_auth(&access_token).json(&body)
        };

        let response = request
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let saved =
            parse_json_response::<GoogleEventItem>(response, "google event upsert request").await?;

        Ok(google_event_item_to_event(saved, calendar_id, None))
    }

    #[tauri::command]
    pub async fn google_delete_primary_event(
        state: State<'_, GoogleAuthStore>,
        event_id: String,
        calendar_id: Option<String>,
    ) -> Result<(), String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };
        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;
        let target_calendar_id = calendar_id.unwrap_or_else(|| "primary".to_string());
        let url = format!("{}/{}", google_calendar_events_url(&target_calendar_id)?, event_id);

        client
            .delete(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;

        Ok(())
    }

    #[tauri::command]
    pub async fn google_fetch_task_lists(
        state: State<'_, GoogleAuthStore>,
    ) -> Result<Vec<GoogleTaskListEntry>, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };
        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;
        let response = fetch_all_task_lists(&client, &access_token).await?;
        Ok(response
            .unwrap_or_default()
            .into_iter()
            .map(|item| GoogleTaskListEntry {
                id: item.id,
                title: item.title,
            })
            .collect())
    }

    #[tauri::command]
    pub async fn google_fetch_tasks(
        state: State<'_, GoogleAuthStore>,
    ) -> Result<Vec<GoogleTaskItem>, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };

        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;
        let task_lists = fetch_all_task_lists(&client, &access_token)
            .await?
            .unwrap_or_default();

        let mut all_tasks = Vec::new();

        for task_list in task_lists {
            let mut page_token: Option<String> = None;

            loop {
                let mut url = Url::parse("https://tasks.googleapis.com/tasks/v1/lists")
                    .map_err(|error| error.to_string())?;
                {
                    let mut segments = url
                        .path_segments_mut()
                        .map_err(|_| "Failed to build Google tasks URL.".to_string())?;
                    segments.push(&task_list.id);
                    segments.push("tasks");
                }

                {
                    let mut query = url.query_pairs_mut();
                    query.append_pair("showCompleted", "true");
                    query.append_pair("showHidden", "true");
                    query.append_pair("maxResults", "100");
                    if let Some(token) = page_token.as_deref() {
                        query.append_pair("pageToken", token);
                    }
                }

                let response = client
                    .get(url)
                    .bearer_auth(&access_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?;
                let response = parse_json_response::<GoogleTasksResponse>(
                    response,
                    "google tasks list request",
                )
                .await?;

                if let Some(items) = response.items {
                    for task in items {
                        all_tasks.push(google_task_to_item(task, task_list.id.clone()));
                    }
                }

                page_token = response.next_page_token;
                if page_token.is_none() {
                    break;
                }
            }
        }

        Ok(all_tasks)
    }

    #[tauri::command]
    pub async fn google_update_task_due(
        state: State<'_, GoogleAuthStore>,
        task_list_id: String,
        task_id: String,
        due: Option<String>,
    ) -> Result<GoogleTaskItem, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };

        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;

        let mut url = Url::parse("https://tasks.googleapis.com/tasks/v1/lists")
            .map_err(|error| error.to_string())?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Failed to build Google task update URL.".to_string())?;
            segments.push(&task_list_id);
            segments.push("tasks");
            segments.push(&task_id);
        }

        let due_rfc3339 = due
            .as_deref()
            .and_then(|value| value.get(0..10))
            .map(|date| format!("{date}T00:00:00.000Z"));
        let body = GoogleTaskPatchBody { due: due_rfc3339 };

        let response = client
            .patch(url)
            .bearer_auth(&access_token)
            .query(&[("fields", "id,title,notes,due,status,completed,updated")])
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let updated_task =
            parse_json_response::<GoogleTask>(response, "google task due patch request").await?;

        Ok(google_task_to_item(updated_task, task_list_id))
    }

    #[tauri::command]
    pub async fn google_update_task_completion(
        state: State<'_, GoogleAuthStore>,
        task_list_id: String,
        task_id: String,
        completed: bool,
    ) -> Result<GoogleTaskItem, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };

        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;

        let mut url = Url::parse("https://tasks.googleapis.com/tasks/v1/lists")
            .map_err(|error| error.to_string())?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Failed to build Google task update URL.".to_string())?;
            segments.push(&task_list_id);
            segments.push("tasks");
            segments.push(&task_id);
        }

        let body = GoogleTaskStatusPatchBody {
            status: if completed {
                "completed".to_string()
            } else {
                "needsAction".to_string()
            },
        };

        let response = client
            .patch(url)
            .bearer_auth(&access_token)
            .query(&[("fields", "id,title,notes,due,status,completed,updated")])
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let updated_task = parse_json_response::<GoogleTask>(
            response,
            "google task completion patch request",
        )
        .await?;

        Ok(google_task_to_item(updated_task, task_list_id))
    }

    #[tauri::command]
    pub async fn google_create_task(
        state: State<'_, GoogleAuthStore>,
        task_list_id: String,
        title: String,
        due: Option<String>,
        notes: Option<String>,
    ) -> Result<GoogleTaskItem, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };

        if task_list_id.trim().is_empty() {
            return Err("Google task list is required.".to_string());
        }
        if title.trim().is_empty() {
            return Err("Task title is required.".to_string());
        }

        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;

        let mut url = Url::parse("https://tasks.googleapis.com/tasks/v1/lists")
            .map_err(|error| error.to_string())?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Failed to build Google task create URL.".to_string())?;
            segments.push(&task_list_id);
            segments.push("tasks");
        }

        let due_rfc3339 = due
            .as_deref()
            .and_then(|value| value.get(0..10))
            .map(|date| format!("{date}T00:00:00.000Z"));
        let body = GoogleTaskCreateBody {
            title: title.trim().to_string(),
            notes: notes.filter(|value| !value.trim().is_empty()),
            due: due_rfc3339,
        };

        let response = client
            .post(url)
            .bearer_auth(&access_token)
            .query(&[("fields", "id,title,notes,due,status,completed,updated")])
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let created_task =
            parse_json_response::<GoogleTask>(response, "google task create request").await?;

        Ok(google_task_to_item(created_task, task_list_id))
    }

    #[tauri::command]
    pub async fn google_update_task(
        state: State<'_, GoogleAuthStore>,
        task_list_id: String,
        task_id: String,
        title: String,
        due: Option<String>,
        notes: Option<String>,
    ) -> Result<GoogleTaskItem, String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };

        if task_list_id.trim().is_empty() {
            return Err("Google task list is required.".to_string());
        }
        if task_id.trim().is_empty() {
            return Err("Google task id is required.".to_string());
        }
        if title.trim().is_empty() {
            return Err("Task title is required.".to_string());
        }

        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;

        let mut url = Url::parse("https://tasks.googleapis.com/tasks/v1/lists")
            .map_err(|error| error.to_string())?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Failed to build Google task update URL.".to_string())?;
            segments.push(&task_list_id);
            segments.push("tasks");
            segments.push(&task_id);
        }

        let due_rfc3339 = due
            .as_deref()
            .and_then(|value| value.get(0..10))
            .map(|date| format!("{date}T00:00:00.000Z"));
        let body = GoogleTaskUpdateBody {
            title: title.trim().to_string(),
            notes: notes.filter(|value| !value.trim().is_empty()),
            due: due_rfc3339,
        };

        let response = client
            .patch(url)
            .bearer_auth(&access_token)
            .query(&[("fields", "id,title,notes,due,status,completed,updated")])
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let updated_task =
            parse_json_response::<GoogleTask>(response, "google task update request").await?;

        Ok(google_task_to_item(updated_task, task_list_id))
    }

    #[tauri::command]
    pub async fn google_delete_task(
        state: State<'_, GoogleAuthStore>,
        task_list_id: String,
        task_id: String,
    ) -> Result<(), String> {
        let allow_insecure_tls = {
            let guard = state
                .0
                .lock()
                .map_err(|_| "Failed to read auth state.".to_string())?;
            guard
                .as_ref()
                .map(|tokens| tokens.allow_insecure_tls)
                .ok_or_else(|| "Not signed in with Google.".to_string())?
        };

        if task_list_id.trim().is_empty() {
            return Err("Google task list is required.".to_string());
        }
        if task_id.trim().is_empty() {
            return Err("Google task id is required.".to_string());
        }

        let access_token = ensure_access_token(state).await?;
        let client = google_http_client(allow_insecure_tls)?;

        let mut url = Url::parse("https://tasks.googleapis.com/tasks/v1/lists")
            .map_err(|error| error.to_string())?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Failed to build Google task delete URL.".to_string())?;
            segments.push(&task_list_id);
            segments.push("tasks");
            segments.push(&task_id);
        }

        client
            .delete(url)
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;

        Ok(())
    }
}

async fn perform_google_oauth(
    client_id: String,
    client_secret: Option<String>,
    allow_insecure_tls: bool,
) -> Result<GoogleTokens, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let redirect_uri = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(|error| error.to_string())?.port());

    let code_verifier: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(96)
        .map(char::from)
        .collect();
    let code_challenge =
        URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));

    let scopes = GOOGLE_SCOPES.join(" ");
    let auth_url = Url::parse_with_params(
        GOOGLE_AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", scopes.as_str()),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("code_challenge", code_challenge.as_str()),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(|error| error.to_string())?;

    open_auth_url(auth_url.as_str())?;
    let auth_code = wait_for_auth_code(listener)?;

    let client = google_http_client(allow_insecure_tls)?;
    let response = exchange_auth_code_for_tokens(
        &client,
        client_id.as_str(),
        client_secret.as_deref(),
        auth_code.as_str(),
        code_verifier.as_str(),
        redirect_uri.as_str(),
    )
    .await?;

    Ok(GoogleTokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        expires_at: unix_now() + response.expires_in.saturating_sub(60),
        client_id,
        client_secret,
        allow_insecure_tls,
        scopes: response
            .scope
            .unwrap_or_else(|| GOOGLE_SCOPES.join(" "))
            .split_whitespace()
            .map(ToString::to_string)
            .collect(),
    })
}

fn wait_for_auth_code(listener: TcpListener) -> Result<String, String> {
    let started = SystemTime::now();
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buffer = [0_u8; 4096];
                let read = stream.read(&mut buffer).map_err(|error| error.to_string())?;
                let request = String::from_utf8_lossy(&buffer[..read]);
                let first_line = request
                    .lines()
                    .next()
                    .ok_or_else(|| "Invalid OAuth callback request.".to_string())?;
                let path = first_line
                    .split_whitespace()
                    .nth(1)
                    .ok_or_else(|| "Missing callback path.".to_string())?;
                let callback_url =
                    Url::parse(&format!("http://localhost{}", path)).map_err(|error| error.to_string())?;

                let params: HashMap<String, String> = callback_url
                    .query_pairs()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect();

                let (status_line, body) = if let Some(error) = params.get("error") {
                    (
                        "HTTP/1.1 400 Bad Request",
                        format!("Google sign-in failed: {error}. You can close this window."),
                    )
                } else {
                    (
                        "HTTP/1.1 200 OK",
                        "Google sign-in finished. You can close this window.".to_string(),
                    )
                };

                let response = format!(
                    "{status_line}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();

                if let Some(error) = params.get("error") {
                    return Err(format!("Google returned OAuth error: {error}"));
                }

                if let Some(code) = params.get("code") {
                    return Ok(code.to_string());
                }

                return Err("OAuth callback did not contain an authorization code.".to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if started.elapsed().unwrap_or(Duration::ZERO) > Duration::from_secs(180) {
                    return Err("Timed out waiting for the Google OAuth callback.".to_string());
                }

                std::thread::sleep(Duration::from_millis(150));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

async fn fetch_google_user_info(
    access_token: &str,
    scopes: &[String],
    allow_insecure_tls: bool,
) -> Result<GoogleSession, String> {
    let client = google_http_client(allow_insecure_tls)?;
    let response = client
        .get(GOOGLE_USERINFO_URL)
        .header("Accept", "application/json")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("userinfo request failed: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("failed to read userinfo response body: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "userinfo endpoint returned {status}{}",
            if body.trim().is_empty() {
                String::new()
            } else {
                format!(" with body: {}", truncate_for_log(&body, 600))
            }
        ));
    }

    let user_info = serde_json::from_str::<GoogleUserInfo>(&body).map_err(|error| {
        format!(
            "failed to parse userinfo response: {error}; body snippet: {}",
            truncate_for_log(&body, 600)
        )
    })?;

    Ok(GoogleSession {
        email: user_info.email,
        name: user_info.name,
        picture: user_info.picture,
        scopes: scopes.to_vec(),
    })
}

async fn ensure_access_token(state: State<'_, GoogleAuthStore>) -> Result<String, String> {
    let current = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Failed to read auth state.".to_string())?;
        guard
            .clone()
            .ok_or_else(|| "Not signed in with Google.".to_string())?
    };

    if current.expires_at > unix_now() + 30 {
        return Ok(current.access_token);
    }

    let refresh_token = current
        .refresh_token
        .clone()
        .ok_or_else(|| "No refresh token available. Please sign in again.".to_string())?;

    let client = google_http_client(current.allow_insecure_tls)?;
    let response = refresh_access_token(
        &client,
        current.client_id.as_str(),
        current.client_secret.as_deref(),
        refresh_token.as_str(),
    )
    .await?;

    let updated = GoogleTokens {
        access_token: response.access_token.clone(),
        refresh_token: response.refresh_token.or(Some(refresh_token)),
        expires_at: unix_now() + response.expires_in.saturating_sub(60),
        client_id: current.client_id,
        client_secret: current.client_secret,
        allow_insecure_tls: current.allow_insecure_tls,
        scopes: response
            .scope
            .unwrap_or_else(|| current.scopes.join(" "))
            .split_whitespace()
            .map(ToString::to_string)
            .collect(),
    };

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Failed to update auth state.".to_string())?;
    *guard = Some(updated.clone());

    Ok(updated.access_token)
}

fn google_tokens_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    path.push("google_tokens.json");
    Ok(path)
}

fn store_google_tokens(app: &AppHandle, tokens: &GoogleTokens) -> Result<(), String> {
    let path = google_tokens_path(app)?;
    let json = serde_json::to_string(tokens).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

fn load_google_tokens(app: &AppHandle) -> Result<Option<GoogleTokens>, String> {
    let path = google_tokens_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let json = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let tokens = serde_json::from_str::<GoogleTokens>(&json).map_err(|error| error.to_string())?;
    Ok(Some(tokens))
}

fn clear_google_tokens(app: &AppHandle) -> Result<(), String> {
    let path = google_tokens_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn open_auth_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Failed to open browser: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Failed to open browser: {error}"))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Failed to open browser: {error}"))?;
        Ok(())
    }
}

fn google_http_client(allow_insecure_tls: bool) -> Result<Client, String> {
    Client::builder()
        .danger_accept_invalid_certs(allow_insecure_tls)
        .build()
        .map_err(|error| format!("Failed to initialize HTTP client: {error}"))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

fn google_calendar_events_url(calendar_id: &str) -> Result<String, String> {
    let mut url = Url::parse("https://www.googleapis.com/calendar/v3/calendars")
        .map_err(|error| error.to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Failed to build calendar URL.".to_string())?;
        segments.push(calendar_id);
        segments.push("events");
    }
    Ok(url.to_string())
}

fn is_task_like_calendar(id: &str, summary: &str) -> bool {
    let id_lower = id.to_lowercase();
    let summary_lower = summary.to_lowercase();
    id_lower.contains("task")
        || id_lower.contains("todo")
        || summary_lower.contains("task")
        || summary_lower.contains("todo")
        || summary.contains("할 일")
        || summary.contains("할일")
        || summary.contains("작업")
}

fn google_event_item_to_event(
    item: GoogleEventItem,
    calendar_id: String,
    calendar_color: Option<String>,
) -> GoogleCalendarEvent {
    let guests = item.attendees.and_then(|entries| {
        let emails = entries
            .into_iter()
            .filter_map(|entry| entry.email.map(|value| value.trim().to_string()))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if emails.is_empty() {
            None
        } else {
            Some(emails)
        }
    });

    GoogleCalendarEvent {
        id: item.id,
        calendar_id,
        title: item.summary.unwrap_or_else(|| "(untitled event)".to_string()),
        start: item
            .start
            .date_time
            .clone()
            .or(item.start.date.clone())
            .unwrap_or_default(),
        end: item
            .end
            .as_ref()
            .and_then(|value| value.date_time.clone().or(value.date.clone())),
        all_day: item.start.date.is_some(),
        description: item.description,
        location: item.location,
        guests,
        // Use per-calendar color so event chips match Google calendar color.
        color: calendar_color,
        source: "google".to_string(),
    }
}

fn google_task_to_item(task: GoogleTask, task_list_id: String) -> GoogleTaskItem {
    let due = task
        .due
        .as_deref()
        .and_then(|value| value.get(0..10))
        .map(ToString::to_string);
    let completed = task.status.as_deref() == Some("completed") || task.completed.is_some();
    let updated_at = task
        .updated
        .unwrap_or_else(|| task.completed.unwrap_or_else(|| "".to_string()));

    GoogleTaskItem {
        id: task.id,
        task_list_id,
        title: task.title.unwrap_or_else(|| "(untitled task)".to_string()),
        due,
        notes: task.notes,
        completed,
        updated_at,
    }
}

async fn fetch_all_calendar_list_items(
    client: &Client,
    access_token: &str,
) -> Result<Vec<GoogleCalendarListItem>, String> {
    let mut all_items = fetch_calendar_list_variant(
        client,
        access_token,
        Some("true"),
        Some("false"),
    )
    .await?;

    // Some accounts/environments unexpectedly return only primary with a single query shape.
    // Retry with alternate query variants and merge unique calendars by id.
    if all_items.len() <= 1 {
        let fallback_default =
            fetch_calendar_list_variant(client, access_token, None, Some("false")).await?;
        merge_calendar_list_items(&mut all_items, fallback_default);

        let fallback_with_deleted =
            fetch_calendar_list_variant(client, access_token, Some("true"), Some("true")).await?;
        merge_calendar_list_items(&mut all_items, fallback_with_deleted);
    }

    all_items.retain(|item| !item.deleted.unwrap_or(false));

    Ok(all_items)
}

async fn fetch_calendar_color_map(
    client: &Client,
    access_token: &str,
) -> Result<HashMap<String, String>, String> {
    let response = client
        .get("https://www.googleapis.com/calendar/v3/colors")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let payload = parse_json_response::<GoogleColorsResponse>(response, "google colors request")
        .await?;

    let mut map = HashMap::new();
    for (id, entry) in payload.calendar {
        if let Some(bg) = entry.background {
            map.insert(id, bg);
        }
    }
    Ok(map)
}

async fn fetch_calendar_list_variant(
    client: &Client,
    access_token: &str,
    show_hidden: Option<&str>,
    show_deleted: Option<&str>,
) -> Result<Vec<GoogleCalendarListItem>, String> {
    let mut all_items = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut request = client
            .get(GOOGLE_CALENDAR_LIST_URL)
            .bearer_auth(access_token)
            .query(&[("maxResults", "250")]);
        if let Some(value) = show_hidden {
            request = request.query(&[("showHidden", value)]);
        }
        if let Some(value) = show_deleted {
            request = request.query(&[("showDeleted", value)]);
        }
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }

        let response = request
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let response = parse_json_response::<GoogleCalendarListResponse>(
            response,
            "google calendar list request",
        )
        .await?;

        if let Some(items) = response.items {
            all_items.extend(items);
        }

        page_token = response.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    Ok(all_items)
}

fn merge_calendar_list_items(
    target: &mut Vec<GoogleCalendarListItem>,
    source: Vec<GoogleCalendarListItem>,
) {
    let mut index_by_id = target
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.clone(), index))
        .collect::<HashMap<String, usize>>();

    for item in source {
        if let Some(index) = index_by_id.get(&item.id).copied() {
            let existing = &mut target[index];
            if !item.summary.as_deref().unwrap_or_default().trim().is_empty() {
                existing.summary = item.summary.clone();
            }
            if item.color_id.is_some() {
                existing.color_id = item.color_id.clone();
            }
            if item.background_color.is_some() {
                existing.background_color = item.background_color.clone();
            }
            if item.foreground_color.is_some() {
                existing.foreground_color = item.foreground_color.clone();
            }
            if item.access_role.is_some() {
                existing.access_role = item.access_role.clone();
            }
            if item.primary.is_some() {
                existing.primary = item.primary;
            }
            if item.selected.is_some() {
                existing.selected = item.selected;
            }
            continue;
        }

        index_by_id.insert(item.id.clone(), target.len());
        target.push(item);
    }
}

async fn fetch_all_task_lists(
    client: &Client,
    access_token: &str,
) -> Result<Option<Vec<GoogleTaskListItem>>, String> {
    let mut all_items = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut request = client.get(GOOGLE_TASK_LISTS_URL).bearer_auth(access_token);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }

        let response = request
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let response = parse_json_response::<GoogleTaskListsResponse>(
            response,
            "google task lists request",
        )
        .await?;

        if let Some(items) = response.items {
            all_items.extend(items);
        }

        page_token = response.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    if all_items.is_empty() {
        Ok(None)
    } else {
        Ok(Some(all_items))
    }
}

fn to_google_event_time(value: &str, all_day: bool) -> GoogleEventDateTimeWrite {
    if all_day {
        return GoogleEventDateTimeWrite {
            date: value.get(0..10).map(ToString::to_string),
            date_time: None,
        };
    }

    GoogleEventDateTimeWrite {
        date: None,
        date_time: Some(value.to_string()),
    }
}

async fn exchange_auth_code_for_tokens(
    client: &Client,
    client_id: &str,
    client_secret: Option<&str>,
    auth_code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let mut form = std::collections::HashMap::new();
    form.insert("client_id", client_id.to_string());
    if let Some(secret) = client_secret {
        form.insert("client_secret", secret.to_string());
    }
    form.insert("code", auth_code.to_string());
    form.insert("code_verifier", code_verifier.to_string());
    form.insert("redirect_uri", redirect_uri.to_string());
    form.insert("grant_type", "authorization_code".to_string());

    let primary = post_token_request(
        client,
        GOOGLE_TOKEN_URL,
        &form,
    )
    .await;

    match primary {
        Ok(tokens) => Ok(tokens),
        Err(primary_error) => post_token_request(
            client,
            GOOGLE_TOKEN_FALLBACK_URL,
            &form,
        )
        .await
        .map_err(|fallback_error| {
            format!(
                "Token exchange failed. Primary endpoint error: {primary_error}. Fallback endpoint error: {fallback_error}"
            )
        }),
    }
}

async fn refresh_access_token(
    client: &Client,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let mut form = std::collections::HashMap::new();
    form.insert("client_id", client_id.to_string());
    if let Some(secret) = client_secret {
        form.insert("client_secret", secret.to_string());
    }
    form.insert("refresh_token", refresh_token.to_string());
    form.insert("grant_type", "refresh_token".to_string());

    let primary = post_token_request(
        client,
        GOOGLE_TOKEN_URL,
        &form,
    )
    .await;

    match primary {
        Ok(tokens) => Ok(tokens),
        Err(primary_error) => post_token_request(
            client,
            GOOGLE_TOKEN_FALLBACK_URL,
            &form,
        )
        .await
        .map_err(|fallback_error| {
            format!(
                "Access token refresh failed. Primary endpoint error: {primary_error}. Fallback endpoint error: {fallback_error}"
            )
        }),
    }
}

async fn post_token_request(
    client: &Client,
    url: &str,
    form: &std::collections::HashMap<&str, String>,
) -> Result<TokenResponse, String> {
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|error| format!("request to {url} failed: {error} (debug: {error:?})"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "token endpoint {url} returned {status}{}",
            if body.is_empty() {
                String::new()
            } else {
                format!(" with body: {body}")
            }
        ));
    }

    let body = response
        .text()
        .await
        .map_err(|error| format!("failed to read token response body from {url}: {error}"))?;

    serde_json::from_str::<TokenResponse>(&body).map_err(|error| {
        format!(
            "failed to parse token response from {url}: {error}; body snippet: {}",
            truncate_for_log(&body, 600)
        )
    })
}

async fn parse_json_response<T: DeserializeOwned>(
    response: reqwest::Response,
    context: &str,
) -> Result<T, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("{context}: failed to read response body: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "{context}: HTTP {status}{}",
            if body.trim().is_empty() {
                String::new()
            } else {
                format!(" body: {}", truncate_for_log(&body, 600))
            }
        ));
    }

    serde_json::from_str::<T>(&body).map_err(|error| {
        format!(
            "{context}: failed to parse JSON response: {error}; body snippet: {}",
            truncate_for_log(&body, 600)
        )
    })
}

fn truncate_for_log(input: &str, max_chars: usize) -> String {
    let cleaned = input.replace('\n', " ").replace('\r', " ");
    if cleaned.chars().count() <= max_chars {
        return cleaned;
    }
    let mut out = String::new();
    for (index, ch) in cleaned.chars().enumerate() {
        if index >= max_chars {
            break;
        }
        out.push(ch);
    }
    out.push_str("...");
    out
}

#[cfg(target_os = "windows")]
fn open_external_url_impl(url: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn open_external_url_impl(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_external_url_impl(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn apply_windows_dock_mode(window: &Window, settings: &DockSettings) -> Result<(), String> {
    use tauri::Position;

    if settings.dock_mode {
        let monitor = window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Failed to locate the active monitor.".to_string())?;
        let work_area = monitor.work_area();
        let dock_width = work_area.size.width * 2 / 3;
        let x = if settings.dock_side == "right" {
            work_area.position.x + (work_area.size.width - dock_width) as i32
        } else {
            work_area.position.x
        };

        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: dock_width,
                height: work_area.size.height,
            }))
            .map_err(|error| error.to_string())?;
        window
            .set_position(Position::Physical(tauri::PhysicalPosition {
                x,
                y: work_area.position.y,
            }))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_macos_window_mode(window: &Window, settings: &DockSettings) -> Result<(), String> {
    if settings.dock_mode {
        window
            .set_decorations(false)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_windows_dock_mode(_window: &Window, _settings: &DockSettings) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn apply_macos_window_mode(_window: &Window, _settings: &DockSettings) -> Result<(), String> {
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(WindowStateStore::default())
        .manage(GoogleAuthStore::default())
        .invoke_handler(tauri::generate_handler![
            commands::apply_dock_settings,
            commands::load_window_state,
            commands::open_external_url,
            commands::google_sign_in,
            commands::google_sign_out,
            commands::google_restore_session,
            commands::google_fetch_calendar_list,
            commands::google_fetch_primary_events,
            commands::google_set_calendar_selected,
            commands::google_upsert_primary_event,
            commands::google_delete_primary_event,
            commands::google_fetch_task_lists,
            commands::google_fetch_tasks,
            commands::google_update_task_due,
            commands::google_update_task_completion,
            commands::google_create_task,
            commands::google_update_task,
            commands::google_delete_task
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
                let _ = window.show();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
