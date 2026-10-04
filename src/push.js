// Handy-Push-Benachrichtigungen (Web Push): Abo anlegen und beim Server melden.
import { socket } from "./socket";

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function pushPermission() {
  return pushSupported() ? Notification.permission : "unsupported";
}

function toKey(base64Url) {
  const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  return { registration, subscription: await registration.pushManager.getSubscription() };
}

/** Fragt (falls nötig) nach der Erlaubnis, legt das Abo an und meldet es dem Server. */
export async function enablePush(authToken) {
  if (!pushSupported()) throw new Error("Dieses Gerät oder dieser Browser unterstützt keine Push-Benachrichtigungen.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Benachrichtigungen sind blockiert. Erlaube sie in den Browser-Einstellungen.");
  const { registration, subscription: existing } = await currentSubscription();
  const keyReply = await socket.request("pushKey", { authToken });
  if (!keyReply.ok) throw new Error(keyReply.message || "Push ist gerade nicht verfügbar.");
  const subscription = existing || (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(keyReply.key) }));
  const reply = await socket.request("pushSubscribe", { authToken, subscription: subscription.toJSON() });
  if (!reply.ok) throw new Error(reply.message || "Das Push-Abo konnte nicht gespeichert werden.");
  return true;
}

/** Ist dieses Gerät schon abonniert? Meldet das Abo dabei erneut dem Server (hält es aktuell). */
export async function syncPush(authToken) {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const { subscription } = await currentSubscription();
  if (!subscription) return false;
  await socket.request("pushSubscribe", { authToken, subscription: subscription.toJSON() });
  return true;
}

export async function disablePush(authToken) {
  if (!pushSupported()) return;
  const { subscription } = await currentSubscription();
  if (!subscription) return;
  await socket.request("pushUnsubscribe", { authToken, endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}
