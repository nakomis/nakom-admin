# RDS Auto-Shutdown Timer — Design

**Goal:** When RDS is started via the admin app, automatically stop it after 30 minutes, with the ability to extend the timer and see remaining time on any page refresh.

**Architecture:** A one-shot EventBridge Scheduler rule fires at the computed shutdown time and invokes the existing `rds-control` Lambda with `{ action: "stop" }`. The shutdown timestamp is stored in SSM so the UI can calculate remaining time without polling. The SSM parameter is deleted (not blanked) whenever RDS stops — whether by timer, manual stop, or backup+stop — so a missing parameter unambiguously means no active timer.

---

## Components

### SSM Parameter: `/nakom-admin/rds/shutdown-at`
Stores the ISO 8601 shutdown timestamp while a timer is active. **Deleted** on every RDS stop path. Absent = no timer.

### EventBridge Scheduler rule: `nakom-admin-rds-shutdown`
One-shot schedule in the default group. Fires at `shutdownAt` and invokes `rds-control` Lambda with `{ "action": "stop" }`. Recreated (delete + create) when the timer is extended.

### Scheduler IAM role: `nakom-admin-rds-scheduler-role`
Trusted by `scheduler.amazonaws.com`. Grants `lambda:InvokeFunction` on the `rds-control` Lambda. Required for EventBridge Scheduler to invoke Lambda.

---

## Lambda changes (rds-control)

| Action | Behaviour |
|---|---|
| `start` (enhanced) | Start RDS + write SSM `shutdownAt` (now + 30 min) + create one-shot schedule |
| `stop` (enhanced) | Stop RDS + delete SSM + delete schedule |
| `snapshot` (enhanced) | Create snapshot + stop RDS + delete SSM + delete schedule |
| `timer` (new) | Read SSM; return `{ shutdownAt: string \| null }` |
| `extend-timer` (new) | Read SSM, add 30 min, write new SSM, delete old schedule, create new schedule |

EventBridge fires `{ action: "stop" }` — same code path as manual stop.

---

## New API routes

```
GET  /rds/timer         → rds-control Lambda
POST /rds/extend-timer  → rds-control Lambda
```

---

## CDK changes

- **SSM permissions** on `rds-control` Lambda: `ssm:GetParameter`, `ssm:PutParameter`, `ssm:DeleteParameter` for `/nakom-admin/rds/shutdown-at`
- **Scheduler permissions**: `scheduler:CreateSchedule`, `scheduler:DeleteSchedule`, `scheduler:GetSchedule`
- **New IAM role** `nakom-admin-rds-scheduler-role`: trusted by `scheduler.amazonaws.com`, grants `lambda:InvokeFunction` on rds-control ARN
- **Two new routes** added to `ApiStack`

---

## UI changes (AnalyticsPage.tsx)

- On mount: call `GET /rds/timer` alongside `GET /rds/status`; compute remaining seconds and start a `setInterval` ticking every second
- Display remaining time in the RDS Control card (e.g. `⏱ 28:14 remaining`)
- Show "Extend Time" button when timer is active; on click calls `POST /rds/extend-timer` and refreshes the timer display
- After clicking Start, re-fetch timer to pick up the new `shutdownAt`
- After Stop / Backup+Stop, clear the local timer state
