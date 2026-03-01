# RDS Auto-Shutdown Timer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When RDS is started via the admin app, automatically stop it after 30 minutes — with a server-side timer that survives browser closes, an Extend Time button, and a live countdown on the page.

**Architecture:** `rds-control` Lambda is enhanced to manage an SSM parameter (`/nakom-admin/rds/shutdown-at`) and a one-shot EventBridge Scheduler rule. The scheduler fires the Lambda with `{ action: "stop" }` at the scheduled time. The UI reads `shutdownAt` from a new `GET /rds/timer` endpoint and ticks a client-side countdown — no polling required. The SSM parameter is deleted (not blanked) on every RDS stop path so a missing parameter unambiguously means no active timer.

**Tech Stack:** TypeScript, AWS CDK, `@aws-sdk/client-scheduler`, `@aws-sdk/client-ssm`, React + MUI, `analyticsService.ts`

---

### Task 1: CDK — IAM role, permissions, env vars, and new routes

**Files:**
- Modify: `infra/lib/api-stack.ts`

**Context:** We're working in `/Users/martinmu_1/repos/nakomis/nakom-admin` on branch `add-rds-shutdown-timer`. The `rdsControl` NodejsFunction is defined around line 60. The `addRoute` helper is at line 235. Routes are added from line 244 onwards.

**Step 1: Add the scheduler IAM role and wire environment variables**

After the `rdsControl` function definition (after the last `rdsControl.addToRolePolicy` call, around line 133), add:

```typescript
        // Scheduler IAM role — allows EventBridge Scheduler to invoke rds-control
        const schedulerRole = new iam.Role(this, 'RdsSchedulerRole', {
            roleName: 'nakom-admin-rds-scheduler-role',
            assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
        });
        schedulerRole.addToPolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [rdsControl.functionArn],
        }));

        // Give rds-control its own ARN and the scheduler role ARN
        rdsControl.addEnvironment('LAMBDA_ARN', rdsControl.functionArn);
        rdsControl.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);

        // SSM: read/write/delete the shutdown-at timestamp
        rdsControl.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
            resources: [`arn:aws:ssm:${region}:${account}:parameter/nakom-admin/rds/shutdown-at`],
        }));

        // EventBridge Scheduler: create and delete the one-shot rule
        rdsControl.addToRolePolicy(new iam.PolicyStatement({
            actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
            resources: [`arn:aws:scheduler:${region}:${account}:schedule/default/nakom-admin-rds-shutdown`],
        }));
```

**Step 2: Add the two new API routes**

After `addRoute(apigwv2.HttpMethod.POST, '/rds/stop', rdsControl);` add:

```typescript
        addRoute(apigwv2.HttpMethod.GET, '/rds/timer', rdsControl);
        addRoute(apigwv2.HttpMethod.POST, '/rds/extend-timer', rdsControl);
```

**Step 3: Verify the file compiles**

```bash
cd infra && npx tsc --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add infra/lib/api-stack.ts
git commit -m "feat: CDK — scheduler role, SSM/scheduler permissions, new timer routes"
```

---

### Task 2: Lambda — helper functions and `timer` action

**Files:**
- Modify: `infra/lambda/rds-control/handler.ts`

**Context:** We need SSM helpers (get/set/delete shutdown-at) and a Scheduler helper (create/delete rule). The Lambda runtime (Node 20.x) includes `@aws-sdk/client-scheduler` and `@aws-sdk/client-ssm` — no package install needed.

**Step 1: Add imports at the top of the file**

After the existing imports, add:

```typescript
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
```

**Step 2: Add client instances and constants after the existing client declarations**

After `const ssm = new SSMClient({});` in the existing code (but that's in import-generate — in rds-control there is no ssm client yet), add after the `const ssm = new SSMClient({});` line that you're about to create:

```typescript
const schedulerClient = new SchedulerClient({});
const ssmClient = new SSMClient({});

const SCHEDULE_NAME = 'nakom-admin-rds-shutdown';
const SHUTDOWN_AT_PARAM = '/nakom-admin/rds/shutdown-at';
const TIMER_DURATION_MS = 30 * 60 * 1000;
```

**Step 3: Add helper functions before the `handler` export**

```typescript
async function getShutdownAt(): Promise<string | null> {
    try {
        const r = await ssmClient.send(new GetParameterCommand({ Name: SHUTDOWN_AT_PARAM }));
        return r.Parameter?.Value ?? null;
    } catch (e: any) {
        if (e.name === 'ParameterNotFound') return null;
        throw e;
    }
}

async function setShutdownAt(iso: string): Promise<void> {
    await ssmClient.send(new PutParameterCommand({
        Name: SHUTDOWN_AT_PARAM,
        Value: iso,
        Type: 'String',
        Overwrite: true,
    }));
}

async function clearShutdownAt(): Promise<void> {
    try {
        await ssmClient.send(new DeleteParameterCommand({ Name: SHUTDOWN_AT_PARAM }));
    } catch (e: any) {
        if (e.name !== 'ParameterNotFound') throw e;
    }
}

async function createShutdownSchedule(shutdownAt: Date): Promise<void> {
    // Format: at(yyyy-MM-ddTHH:mm:ss) — EventBridge requires no milliseconds or Z suffix
    const expr = `at(${shutdownAt.toISOString().replace(/\.\d{3}Z$/, '')})`;
    await schedulerClient.send(new CreateScheduleCommand({
        Name: SCHEDULE_NAME,
        ScheduleExpression: expr,
        ScheduleExpressionTimezone: 'UTC',
        Target: {
            Arn: process.env.LAMBDA_ARN!,
            RoleArn: process.env.SCHEDULER_ROLE_ARN!,
            Input: JSON.stringify({ action: 'stop' }),
        },
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
    }));
}

async function deleteShutdownSchedule(): Promise<void> {
    try {
        await schedulerClient.send(new DeleteScheduleCommand({ Name: SCHEDULE_NAME }));
    } catch (e: any) {
        if (e.name !== 'ResourceNotFoundException') throw e;
        // Already deleted (schedule fired and auto-deleted, or never existed)
    }
}
```

**Step 4: Add the `timer` action to the switch statement**

In the `switch (action)` block, before the `default:` case, add:

```typescript
        case 'timer': {
            const shutdownAt = await getShutdownAt();
            result = { shutdownAt: shutdownAt ?? null };
            break;
        }
```

**Step 5: Verify the file compiles**

```bash
cd infra && npx tsc --noEmit
```

Expected: no errors.

**Step 6: Commit**

```bash
git add infra/lambda/rds-control/handler.ts
git commit -m "feat: rds-control — SSM/scheduler helpers and timer read action"
```

---

### Task 3: Lambda — enhance `start` to set the timer

**Files:**
- Modify: `infra/lambda/rds-control/handler.ts`

**Context:** When RDS starts, we write `shutdownAt` to SSM and create the one-shot EventBridge Scheduler rule. We also delete any stale schedule first (in case the previous run left one behind).

**Step 1: Replace the `start` case**

Find the current `start` case:
```typescript
        case 'start':
            await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            result = { ok: true };
            break;
```

Replace with:
```typescript
        case 'start': {
            await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            const shutdownAt = new Date(Date.now() + TIMER_DURATION_MS);
            await setShutdownAt(shutdownAt.toISOString());
            await deleteShutdownSchedule(); // clear any stale schedule first
            await createShutdownSchedule(shutdownAt);
            result = { ok: true, shutdownAt: shutdownAt.toISOString() };
            break;
        }
```

**Step 2: Compile check**

```bash
cd infra && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add infra/lambda/rds-control/handler.ts
git commit -m "feat: rds-control — set auto-shutdown timer when RDS starts"
```

---

### Task 4: Lambda — enhance `stop` and `snapshot` to clear the timer

**Files:**
- Modify: `infra/lambda/rds-control/handler.ts`

**Context:** Any stop path should delete the SSM parameter and the schedule. This covers manual stop, backup+stop, and the scheduled auto-stop itself (when EventBridge fires `{ action: "stop" }`). `deleteShutdownSchedule` and `clearShutdownAt` both handle "not found" gracefully, so the auto-stop path is safe even though EventBridge auto-deletes the schedule with `ActionAfterCompletion: 'DELETE'`.

**Step 1: Replace the `stop` case**

Find:
```typescript
        case 'stop':
            await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            result = { ok: true };
            break;
```

Replace with:
```typescript
        case 'stop': {
            await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            await clearShutdownAt();
            await deleteShutdownSchedule();
            result = { ok: true };
            break;
        }
```

**Step 2: Enhance the `snapshot` case**

The `snapshot` case ends with `result = { ok: true, snapshotId };`. Add the timer cleanup before that line:

```typescript
            await clearShutdownAt();
            await deleteShutdownSchedule();
            result = { ok: true, snapshotId };
```

**Step 3: Compile check**

```bash
cd infra && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add infra/lambda/rds-control/handler.ts
git commit -m "feat: rds-control — clear timer on manual stop and snapshot"
```

---

### Task 5: Lambda — add `extend-timer` action

**Files:**
- Modify: `infra/lambda/rds-control/handler.ts`

**Context:** Extending the timer means: read current shutdownAt, add 30 min (clamped to at least now+30min in case the timer has already expired), update SSM, replace the schedule.

**Step 1: Add the `extend-timer` case before `default:`**

```typescript
        case 'extend-timer': {
            const current = await getShutdownAt();
            const base = current ? new Date(current) : new Date();
            // Extend from whichever is later: current shutdownAt or now
            const newShutdownAt = new Date(Math.max(base.getTime(), Date.now()) + TIMER_DURATION_MS);
            await setShutdownAt(newShutdownAt.toISOString());
            await deleteShutdownSchedule();
            await createShutdownSchedule(newShutdownAt);
            result = { ok: true, shutdownAt: newShutdownAt.toISOString() };
            break;
        }
```

**Step 2: The HTTP routing block**

The Lambda determines actions from `event.rawPath`. Add `extend-timer` to the routing:

Find the path-to-action block and add:
```typescript
        else if (path === '/rds/extend-timer') action = 'extend-timer';
```

**Step 3: Compile check**

```bash
cd infra && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add infra/lambda/rds-control/handler.ts
git commit -m "feat: rds-control — extend-timer action replaces schedule with +30min"
```

---

### Task 6: Frontend — service methods and fetch timer on mount

**Files:**
- Modify: `web/src/services/analyticsService.ts`
- Modify: `web/src/components/pages/AnalyticsPage.tsx`

**Step 1: Add service methods to `analyticsService.ts`**

After `restoreSnapshot()`, add:

```typescript
    getTimer() { return apiCall<{ shutdownAt: string | null }>(this.creds, '/rds/timer'); }
    extendTimer() { return apiCall<{ ok: boolean; shutdownAt: string }>(this.creds, '/rds/extend-timer', 'POST'); }
```

**Step 2: Add timer state variables to `AnalyticsPage.tsx`**

After the existing state declarations (after `pollRef`), add:

```typescript
    const [shutdownAt, setShutdownAt] = useState<string | null>(null);
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
```

**Step 3: Add the `fetchTimer` callback**

After the `fetchStatus` callback, add:

```typescript
    const fetchTimer = useCallback(async () => {
        try {
            const r = await service.getTimer();
            setShutdownAt(r.shutdownAt ?? null);
        } catch {
            // non-fatal — timer display just won't show
        }
    }, [service]);
```

**Step 4: Add the countdown effect**

After the `useEffect(() => { fetchStatus(); }, [fetchStatus]);` line, add:

```typescript
    useEffect(() => { fetchTimer(); }, [fetchTimer]);

    useEffect(() => {
        if (!shutdownAt) {
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            setSecondsLeft(null);
            return;
        }
        const tick = () => {
            const secs = Math.max(0, Math.round((new Date(shutdownAt).getTime() - Date.now()) / 1000));
            setSecondsLeft(secs);
            if (secs === 0) {
                clearInterval(timerRef.current!);
                timerRef.current = null;
                setShutdownAt(null);
            }
        };
        tick();
        timerRef.current = setInterval(tick, 1000);
        return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
    }, [shutdownAt]);
```

**Step 5: Add helper function before the return statement**

```typescript
    const formatCountdown = (secs: number) => {
        const m = Math.floor(secs / 60).toString().padStart(2, '0');
        const s = (secs % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };
```

**Step 6: Re-fetch timer after Start RDS**

The `rdsAction` call for Start is:
```tsx
onClick={() => rdsAction(() => service.startRds())}
```

Change it to fetch the timer afterwards by wrapping in an async:
```tsx
onClick={async () => { await rdsAction(() => service.startRds()); await fetchTimer(); }}
```

**Step 7: Clear timer state after Stop and Backup+Stop**

For the Stop button:
```tsx
onClick={async () => { await rdsAction(() => service.stopRds()); setShutdownAt(null); }}
```

For the Backup & Stop button:
```tsx
onClick={async () => { await rdsAction(() => service.takeSnapshot()); setShutdownAt(null); }}
```

**Step 8: Commit**

```bash
git add web/src/services/analyticsService.ts web/src/components/pages/AnalyticsPage.tsx
git commit -m "feat: frontend — fetch and countdown shutdown timer, clear on stop"
```

---

### Task 7: Frontend — countdown display and Extend Time button

**Files:**
- Modify: `web/src/components/pages/AnalyticsPage.tsx`

**Context:** Add the timer display and extend button inside the RDS Control card, below the import result line.

**Step 1: Add the `extendTimer` handler**

After the `importNow` function, add:

```typescript
    const extendTimer = async () => {
        setActionLoading(true);
        try {
            const r = await service.extendTimer();
            setShutdownAt(r.shutdownAt);
        } catch (e: any) {
            console.error('Failed to extend timer', e);
        } finally {
            setActionLoading(false);
        }
    };
```

**Step 2: Add the timer display to the JSX**

In the RDS Control `CardContent`, after the `{importResult && ...}` block, add:

```tsx
                        {secondsLeft !== null && (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                                <Typography variant="body2" color="text.secondary">
                                    ⏱ {formatCountdown(secondsLeft)} remaining
                                </Typography>
                                <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={extendTimer}
                                    disabled={actionLoading}
                                >
                                    Extend Time
                                </Button>
                            </Box>
                        )}
```

**Step 3: TypeScript compile check**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add web/src/components/pages/AnalyticsPage.tsx
git commit -m "feat: frontend — show countdown and Extend Time button in RDS Control card"
```

---

### Task 8: Deploy and smoke test

**Context:** Deploy `AdminApiStack` (Lambda code + IAM + routes) then the web app. We do NOT need to redeploy AnalyticsStack or CognitoStack.

**Step 1: Deploy the API stack**

```bash
cd infra
AWS_PROFILE=nakom.is-admin cdk deploy AdminApiStack --require-approval never
```

Expected: stack updates rds-control Lambda, adds IAM role, adds SSM/scheduler permissions, adds two routes. Should complete in ~2 min.

**Step 2: Deploy the web app**

```bash
cd ../web && npm run build && bash scripts/deploy.sh
```

Expected: builds and syncs to S3/CloudFront.

**Step 3: Smoke test — timer on start**

1. Open `https://admin.nakom.is`
2. If RDS is stopped, click **▶ Start RDS**
3. Verify a countdown appears (e.g. `⏱ 29:58 remaining`) within a few seconds
4. Check SSM parameter was created:
   ```bash
   AWS_PROFILE=nakom.is-admin aws ssm get-parameter \
     --name /nakom-admin/rds/shutdown-at --region eu-west-2
   ```
5. Check EventBridge schedule was created:
   ```bash
   AWS_PROFILE=nakom.is-admin aws scheduler get-schedule \
     --name nakom-admin-rds-shutdown --region eu-west-2
   ```

**Step 4: Smoke test — timer survives refresh**

1. Refresh the page
2. Verify countdown resumes from approximately the correct remaining time (not reset to 30:00)

**Step 5: Smoke test — extend timer**

1. Click **Extend Time**
2. Verify countdown jumps up by ~30 minutes

**Step 6: Smoke test — manual stop clears timer**

1. Click **■ Stop RDS** (or **● Backup & Stop**)
2. Verify countdown disappears
3. Verify SSM parameter is deleted:
   ```bash
   AWS_PROFILE=nakom.is-admin aws ssm get-parameter \
     --name /nakom-admin/rds/shutdown-at --region eu-west-2
   ```
   Expected: `ParameterNotFound` error.

**Step 7: Push branch and create PR**

```bash
git push -u origin add-rds-shutdown-timer

gh pr create \
  --title "feat: RDS auto-shutdown timer" \
  --body "$(cat <<'EOF'
## Summary
- Starts a 30-minute server-side countdown when RDS is started via the admin app
- EventBridge Scheduler fires the existing rds-control Lambda with \`{ action: \"stop\" }\` at the scheduled time
- SSM parameter \`/nakom-admin/rds/shutdown-at\` stores the timestamp for client-side countdown calculation
- SSM parameter and schedule are deleted on every stop path (manual, backup, or timer) so a missing param = no active timer
- Frontend shows live countdown and an Extend Time button (+30 min) with no polling

## Test plan
- [ ] Start RDS → countdown appears, SSM param and EventBridge schedule created
- [ ] Refresh page → countdown resumes from correct remaining time
- [ ] Click Extend Time → countdown increases by ~30 min
- [ ] Stop RDS manually → countdown disappears, SSM param deleted
- [ ] Let timer expire → RDS stops automatically, SSM param deleted
EOF
)"
```
