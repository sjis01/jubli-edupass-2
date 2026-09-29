// send-reminders.js
// Runs on GitHub Actions' schedule (see .github/workflows/send-reminders.yml)
// Mirrors checkScheduledHostEmails() from index.html, but runs server-side
// so it works with no browser tab open, all day.

const admin = require("firebase-admin");

// ---- Firebase service account (from GitHub Actions secret) ----
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ---- Same EmailJS IDs your website already uses ----
const EMAILJS_SERVICE_ID = "service_z2z2kip";
const EMAILJS_TEMPLATE_ID = "template_n3c1hmb";
const EMAILJS_OVERDUE_TEMPLATE_ID = "template_xir5ivc";
const EMAILJS_PUBLIC_KEY = "E2WxVKJkkhBIuNT6H";
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY; // from GitHub secret

// TODO: set this to your real site link
const APP_URL = "https://sjis01.github.io/jubli-edupass-2/";

// TODO: adjust if your school is not in this timezone
const TIMEZONE_OFFSET_HOURS = 8; // Malaysia is UTC+8

async function sendHostEmail({
  hostEmail, host, visitorName, visitDate, startTime, endTime,
  notificationType, customLink = ""
}) {
  const activeTemplateId = notificationType.includes("Overdue")
    ? EMAILJS_OVERDUE_TEMPLATE_ID
    : EMAILJS_TEMPLATE_ID;

  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: activeTemplateId,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: hostEmail,
        host_name: host,
        visitor_name: visitorName,
        visit_date: visitDate,
        start_time: startTime,
        end_time: endTime,
        notification_type: notificationType,
        action_link: customLink,
        has_link: customLink ? "true" : ""
      }
    })
  });

  if (!res.ok) {
    throw new Error(`EmailJS error ${res.status}: ${await res.text()}`);
  }
}

function localNow() {
  const utc = new Date();
  return new Date(utc.getTime() + TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
}

async function main() {
  // ---- Testing override ----
  // Leave TEST_DATE / TEST_TIME unset for real, scheduled runs.
  // Set them (via the manual "Run workflow" button) to simulate any date/time,
  // e.g. TEST_DATE=2026-10-05 TEST_TIME=09:50 to test a pass booked for a future day
  // without waiting for it to actually arrive.
  let todayStr, currentTimeVal;

  if (process.env.TEST_DATE && process.env.TEST_TIME) {
    todayStr = process.env.TEST_DATE;
    const [h, m] = process.env.TEST_TIME.split(":").map(Number);
    currentTimeVal = h * 60 + m;
    console.log(`⚠️ TEST MODE: simulating ${todayStr} ${process.env.TEST_TIME}`);
  } else {
    const now = localNow();
    todayStr = now.toISOString().split("T")[0];
    currentTimeVal = now.getUTCHours() * 60 + now.getUTCMinutes();
  }

  const snap = await db.collection("visits")
    .where("status", "==", "Pending")
    .where("visitDate", "==", todayStr)
    .get();

  console.log(`Checked ${snap.size} pending visit(s) for ${todayStr}`);

  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    if (!d.hostEmail || d.hostEmail === "N/A" || !d.startTime) continue;

    const [startH, startM] = d.startTime.split(":").map(Number);
    const startTimeVal = startH * 60 + startM;
    const minutesUntilStart = startTimeVal - currentTimeVal;
    const ackUrl = `${APP_URL}?action=ack&id=${docSnap.id}`;

    try {
      if (!d.email15MinSent && minutesUntilStart <= 15 && minutesUntilStart > 5) {
        await sendHostEmail({
          hostEmail: d.hostEmail, host: d.hostName, visitorName: d.visitorName,
          visitDate: d.visitDate, startTime: d.startTime, endTime: d.endTime,
          notificationType: "Upcoming Visit in 15 Minutes - Please Confirm Readiness",
          customLink: ackUrl
        });
        await docSnap.ref.update({ email15MinSent: true });
        console.log(`Sent 15-min reminder for ${docSnap.id}`);
      }

      if (!d.emailOnTimeSent && currentTimeVal >= startTimeVal && currentTimeVal <= startTimeVal + 5) {
        await sendHostEmail({
          hostEmail: d.hostEmail, host: d.hostName, visitorName: d.visitorName,
          visitDate: d.visitDate, startTime: d.startTime, endTime: d.endTime,
          notificationType: "Visit Starting Now - Please Confirm Readiness",
          customLink: ackUrl
        });
        await docSnap.ref.update({ emailOnTimeSent: true });
        console.log(`Sent on-time reminder for ${docSnap.id}`);
      }
    } catch (err) {
      console.error(`Failed for visit ${docSnap.id}:`, err.message);
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
