/**
 * Browser notifications for a workbench that is often not the foreground tab.
 *
 * The two moments worth interrupting someone for are the two they cannot see
 * coming: the agent is blocked asking for permission, and the turn finished.
 * Everything else stays in the transcript.
 *
 * These are local notifications from the open page, not Web Push — they need
 * no server, no VAPID keys and no subscription, but they only fire while the
 * tab is alive (backgrounded is fine; fully closed is not).
 */

const ENABLED_KEY = "pi-web.notifications";

let registration: ServiceWorkerRegistration | null = null;

/** Register the worker that makes the app installable and owns notification clicks. */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // A dev server serves the worker from /public untranspiled, which is fine —
  // it is plain script, no imports.
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .then((value) => {
        registration = value;
      })
      .catch(() => {
        /* http on a non-localhost origin, or the file is missing */
      });
  });
}

function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

/** Permission the browser has granted, independent of the user's own toggle. */
export function notificationPermission():
  | NotificationPermission
  | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

/** The user's opt-in, which is separate from — and narrower than — the grant. */
export function notificationsEnabled(): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted")
    return false;
  try {
    return localStorage.getItem(ENABLED_KEY) === "on";
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
  } catch {
    /* private mode; the toggle lasts this session only */
  }
}

/** Ask the browser, then remember the answer. Must be called from a gesture. */
export async function requestNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  const result =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
  const granted = result === "granted";
  setNotificationsEnabled(granted);
  return granted;
}

/**
 * Show one notification, replacing any earlier one with the same tag so a
 * chatty session cannot stack a column of them.
 */
export function notify(
  title: string,
  body: string,
  tag: string,
  options: { force?: boolean } = {},
): void {
  if (!notificationsEnabled()) return;
  // The page is already in front of the user — a notification would be noise.
  if (!options.force && document.visibilityState === "visible") return;
  const payload: NotificationOptions = {
    body,
    tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: "/" },
  };
  try {
    if (registration) void registration.showNotification(title, payload);
    else new Notification(title, payload);
  } catch {
    /* Safari throws on the constructor form; nothing to recover */
  }
}
