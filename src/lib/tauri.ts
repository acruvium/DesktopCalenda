import { invoke } from "@tauri-apps/api/core";
import type { DockSettings } from "../types";

export const isTauriRuntime =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window ||
    "__TAURI__" in window ||
    navigator.userAgent.includes("Tauri"));

export const applyDockSettings = async (settings: DockSettings) => {
  if (!isTauriRuntime) {
    return {
      applied: false,
      reason: "browser-preview"
    };
  }

  return invoke("apply_dock_settings", { settings });
};

export const loadWindowState = async () => {
  if (!isTauriRuntime) {
    return null;
  }

  return invoke("load_window_state");
};

export const openExternalUrl = async (url: string) => {
  if (!url.trim()) {
    return;
  }

  if (!isTauriRuntime) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  return invoke("open_external_url", { url });
};
