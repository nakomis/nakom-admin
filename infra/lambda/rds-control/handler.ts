import {
    RDSClient, StartDBInstanceCommand, StopDBInstanceCommand,
    CreateDBSnapshotCommand, DeleteDBSnapshotCommand,
    DescribeDBSnapshotsCommand, DescribeDBInstancesCommand,
    RestoreDBInstanceFromDBSnapshotCommand,
} from '@aws-sdk/client-rds';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const rds = new RDSClient({});
const ssm = new SSMClient({});
const SNAPSHOTS_TO_KEEP = 4;

async function getInstanceId(): Promise<string> {
    const r = await ssm.send(new GetParameterCommand({ Name: '/nakom-admin/rds/instance-id' }));
    return r.Parameter!.Value!;
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

        case 'start':
            await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            result = { ok: true };
            break;

        case 'stop':
            await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            result = { ok: true };
            break;

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
