import {
    RDSClient, StartDBInstanceCommand, StopDBInstanceCommand,
    CreateDBSnapshotCommand, DeleteDBSnapshotCommand,
    DescribeDBSnapshotsCommand, DescribeDBInstancesCommand,
    RestoreDBInstanceFromDBSnapshotCommand,
} from '@aws-sdk/client-rds';
import { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';

const rds = new RDSClient({});
const ssmClient = new SSMClient({});
const schedulerClient = new SchedulerClient({});
const SNAPSHOTS_TO_KEEP = 4;

const SCHEDULE_NAME = 'nakom-admin-rds-shutdown';
const SHUTDOWN_AT_PARAM = '/nakom-admin/rds/shutdown-at';
const TIMER_DURATION_MS = 2 * 60 * 1000;

async function getInstanceId(): Promise<string> {
    const r = await ssmClient.send(new GetParameterCommand({ Name: '/nakom-admin/rds/instance-id' }));
    return r.Parameter!.Value!;
}

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

export const handler = async (event: any) => {
    console.log('Event received:', JSON.stringify(event, null, 2));

    // Extract action from HTTP API Gateway event
    let action: string;

    if (event.action) {
        // Direct invocation
        action = event.action;
    } else if (event.rawPath && event.requestContext) {
        // HTTP API Gateway event
        const path = event.rawPath;
        const method = event.requestContext.http?.method || event.httpMethod;

        if (path === '/rds/status') action = 'status';
        else if (path === '/rds/start') action = 'start';
        else if (path === '/rds/stop') action = 'stop';
        else if (path === '/rds/snapshot') action = 'snapshot';
        else if (path === '/rds/snapshots') action = 'snapshots';
        else if (path === '/rds/restore') action = 'restore';
        else if (path === '/rds/timer') action = 'timer';
        else {
            console.error('Unknown path:', path);
            return {
                statusCode: 404,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: `Unknown path: ${path}` })
            };
        }
    } else {
        console.error('Unable to determine action from event');
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Unable to determine action' })
        };
    }

    console.log('Determined action:', action);

    try {
        const instanceId = await getInstanceId();
        console.log('Instance ID:', instanceId);

        let result;
        switch (action) {
        case 'status': {
            const r = await rds.send(new DescribeDBInstancesCommand({
                DBInstanceIdentifier: instanceId,
            }));
            const db = r.DBInstances?.[0];
            result = { status: db?.DBInstanceStatus, endpoint: db?.Endpoint?.Address };
            break;
        }

        case 'start': {
            await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            const shutdownAt = new Date(Date.now() + TIMER_DURATION_MS);
            await setShutdownAt(shutdownAt.toISOString());
            await deleteShutdownSchedule(); // clear any stale schedule first
            await createShutdownSchedule(shutdownAt);
            result = { ok: true, shutdownAt: shutdownAt.toISOString() };
            break;
        }

        case 'stop': {
            await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            await clearShutdownAt();
            await deleteShutdownSchedule();
            result = { ok: true };
            break;
        }

        case 'snapshot': {
            const snapshotId = `nakom-admin-${Date.now()}`;
            await rds.send(new CreateDBSnapshotCommand({
                DBInstanceIdentifier: instanceId,
                DBSnapshotIdentifier: snapshotId,
            }));
            // Prune old snapshots — keep SNAPSHOTS_TO_KEEP most recent
            const all = await rds.send(new DescribeDBSnapshotsCommand({
                DBInstanceIdentifier: instanceId,
                SnapshotType: 'manual',
            }));
            const sorted = (all.DBSnapshots ?? [])
                .filter(s => s.Status === 'available')
                .sort((a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0));

            for (const old of sorted.slice(SNAPSHOTS_TO_KEEP)) {
                await rds.send(new DeleteDBSnapshotCommand({
                    DBSnapshotIdentifier: old.DBSnapshotIdentifier!,
                }));
            }
            await clearShutdownAt();
            await deleteShutdownSchedule();
            result = { ok: true, snapshotId };
            break;
        }

        case 'snapshots': {
            const r = await rds.send(new DescribeDBSnapshotsCommand({
                DBInstanceIdentifier: instanceId,
                SnapshotType: 'manual',
            }));
            result = r.DBSnapshots
                ?.filter(s => s.Status === 'available')
                .sort((a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0))
                .map(s => ({ id: s.DBSnapshotIdentifier, createdAt: s.SnapshotCreateTime, sizeGb: s.AllocatedStorage }))
                ?? [];
            break;
        }

        case 'restore': {
            const all = await rds.send(new DescribeDBSnapshotsCommand({
                DBInstanceIdentifier: instanceId,
                SnapshotType: 'manual',
            }));
            const latest = (all.DBSnapshots ?? [])
                .filter(s => s.Status === 'available')
                .sort((a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0))[0];
            if (!latest) {
                result = { error: 'No snapshots available' };
                break;
            }

            const newId = `${instanceId}-restored-${Date.now()}`;
            await rds.send(new RestoreDBInstanceFromDBSnapshotCommand({
                DBInstanceIdentifier: newId,
                DBSnapshotIdentifier: latest.DBSnapshotIdentifier!,
                DBInstanceClass: 'db.t4g.micro',
            }));
            result = { ok: true, newInstanceId: newId };
            break;
        }

        case 'timer': {
            const shutdownAt = await getShutdownAt();
            result = { shutdownAt: shutdownAt ?? null };
            break;
        }

        default:
            console.error('Unknown action:', action);
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: `Unknown action: ${action}` })
            };
        }

        console.log('Result:', JSON.stringify(result));

        // Return appropriate response format
        if (event.rawPath && event.requestContext) {
            // HTTP API Gateway response
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
            };
        } else {
            // Direct invocation response
            return result;
        }

    } catch (error) {
        console.error('Error:', error);

        const errorResponse = { error: error instanceof Error ? error.message : 'Unknown error' };

        if (event.rawPath && event.requestContext) {
            // HTTP API Gateway error response
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(errorResponse)
            };
        } else {
            // Direct invocation error response
            return errorResponse;
        }
    }
};
