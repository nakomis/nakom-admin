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

export const handler = async (event: { action: string }) => {
    const instanceId = await getInstanceId();

    switch (event.action) {
        case 'status': {
            const r = await rds.send(new DescribeDBInstancesCommand({
                DBInstanceIdentifier: instanceId,
            }));
            const db = r.DBInstances?.[0];
            return { status: db?.DBInstanceStatus, endpoint: db?.Endpoint?.Address };
        }

        case 'start':
            await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            return { ok: true };

        case 'stop':
            await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
            return { ok: true };

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
            return { ok: true, snapshotId };
        }

        case 'snapshots': {
            const r = await rds.send(new DescribeDBSnapshotsCommand({
                DBInstanceIdentifier: instanceId,
                SnapshotType: 'manual',
            }));
            return r.DBSnapshots
                ?.filter(s => s.Status === 'available')
                .sort((a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0))
                .map(s => ({ id: s.DBSnapshotIdentifier, createdAt: s.SnapshotCreateTime, sizeGb: s.AllocatedStorage }))
                ?? [];
        }

        case 'restore': {
            const all = await rds.send(new DescribeDBSnapshotsCommand({
                DBInstanceIdentifier: instanceId,
                SnapshotType: 'manual',
            }));
            const latest = (all.DBSnapshots ?? [])
                .filter(s => s.Status === 'available')
                .sort((a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0))[0];
            if (!latest) return { error: 'No snapshots available' };

            const newId = `${instanceId}-restored-${Date.now()}`;
            await rds.send(new RestoreDBInstanceFromDBSnapshotCommand({
                DBInstanceIdentifier: newId,
                DBSnapshotIdentifier: latest.DBSnapshotIdentifier!,
                DBInstanceClass: 'db.t4g.micro',
            }));
            return { ok: true, newInstanceId: newId };
        }

        default:
            return { error: `Unknown action: ${event.action}` };
    }
};
