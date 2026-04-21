export const formatDateLabel = (value: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(new Date(value));

export const formatDateTimeLabel = (value: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));

export const isSameDate = (a?: string, b?: string) => {
  if (!a || !b) {
    return false;
  }

  return a.slice(0, 10) === b.slice(0, 10);
};

export const toDateInputValue = (value?: string) => value?.slice(0, 10) ?? "";
