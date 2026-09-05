import { strict as assert } from "node:assert";
import { test } from "node:test";

/**
 * notify.ts talks to browser globals. Stub them before importing so the
 * decision logic — which is the part that decides whether to interrupt someone
 * — is testable without a browser.
 */
const store = new Map<string, string>();
const sent: Array<{ title: string; options: Record<string, unknown> }> = [];

class FakeNotification {
  static permission: string = "granted";
  static requestPermission = async () => FakeNotification.permission;
  constructor(title: string, options: Record<string, unknown>) {
    sent.push({ title, options });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.Notification = FakeNotification;
globals.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
globals.document = { visibilityState: "hidden" };

const {
  notificationsEnabled,
  setNotificationsEnabled,
  requestNotifications,
  notify,
} = await import("./notify.ts");

const reset = (permission = "granted", visibility = "hidden") => {
  store.clear();
  sent.length = 0;
  FakeNotification.permission = permission;
  (globals.document as { visibilityState: string }).visibilityState = visibility;
};

test("stays off until the user opts in, even once the browser has granted", () => {
  reset();
  assert.equal(notificationsEnabled(), false);
  setNotificationsEnabled(true);
  assert.equal(notificationsEnabled(), true);
});

test("a revoked browser permission overrides a stored opt-in", () => {
  reset();
  setNotificationsEnabled(true);
  FakeNotification.permission = "denied";
  assert.equal(notificationsEnabled(), false);
});

test("requesting permission records the answer", async () => {
  reset("granted");
  assert.equal(await requestNotifications(), true);
  assert.equal(notificationsEnabled(), true);

  reset("denied");
  assert.equal(await requestNotifications(), false);
  assert.equal(notificationsEnabled(), false);
});

test("sends nothing while switched off", () => {
  reset();
  notify("Permission needed", "body", "perm:a");
  assert.equal(sent.length, 0);
});

test("stays quiet when the page is already in front of the user", () => {
  reset("granted", "visible");
  setNotificationsEnabled(true);
  notify("Turn finished", "body", "done:a");
  assert.equal(sent.length, 0);
});

test("fires when the page is backgrounded", () => {
  reset("granted", "hidden");
  setNotificationsEnabled(true);
  notify("Permission needed", "wants to run Bash", "perm:a");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Permission needed");
  assert.equal(sent[0].options.body, "wants to run Bash");
  // The tag is what stops a chatty session stacking a column of alerts.
  assert.equal(sent[0].options.tag, "perm:a");
});

test("force sends even a visible page, for the settings test ping", () => {
  reset("granted", "visible");
  setNotificationsEnabled(true);
  notify("Notifications on", "body", "pi-web-test", { force: true });
  assert.equal(sent.length, 1);
});
