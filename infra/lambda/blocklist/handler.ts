import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
    CloudFrontClient, DescribeFunctionCommand,
    UpdateFunctionCommand, PublishFunctionCommand,
} from '@aws-sdk/client-cloudfront';

const ssm = new SSMClient({});
const cf = new CloudFrontClient({ region: 'us-east-1' }); // CF API is global, uses us-east-1

const PARAM_NAME = '/nakom.is/blocked-ips';
const CF_FUNCTION_NAME = 'nakomis-social-redirect';
const MAX_PARAM_BYTES = 3500; // SSM standard limit is 4096; leave headroom

interface BlockEntry { ip: string; blockedAt: string; reason: string; }

async function readBlocklist(): Promise<BlockEntry[]> {
    try {
        const r = await ssm.send(new GetParameterCommand({ Name: PARAM_NAME }));
        return JSON.parse(r.Parameter!.Value!);
    } catch {
        return [];
    }
}

async function writeBlocklist(entries: BlockEntry[]): Promise<void> {
    // FIFO pruning: if serialised size exceeds limit, remove oldest entries first
    let sorted = [...entries].sort((a, b) =>
        new Date(a.blockedAt).getTime() - new Date(b.blockedAt).getTime()
    );
    while (JSON.stringify(sorted).length > MAX_PARAM_BYTES && sorted.length > 0) {
        sorted.shift(); // remove oldest (FIFO)
    }
    await ssm.send(new PutParameterCommand({
        Name: PARAM_NAME,
        Value: JSON.stringify(sorted),
        Type: 'String',
        Overwrite: true,
    }));
}

function renderCfFunction(blockedIps: string[]): string {
    const ipSet = JSON.stringify(blockedIps);
    return `
function handler(event) {
    var BLOCKED = ${ipSet};
    var ip = (event.request.headers['x-forwarded-for'] || {value:''}).value.split(',')[0].trim();
    if (BLOCKED.indexOf(ip) !== -1) {
        return { statusCode: 403, statusDescription: 'Forbidden' };
    }
    var uri = event.request.uri;
    if (uri === '/social' || uri === '/social/') {
        return { statusCode: 301, statusDescription: 'Moved Permanently',
                 headers: { location: { value: '/' } } };
    }
    if (uri === '/') { event.request.uri = '/social'; }
    return event.request;
}`.trim();
}

async function redeployCfFunction(blockedIps: string[]): Promise<void> {
    // Get current ETag
    const desc = await cf.send(new DescribeFunctionCommand({ Name: CF_FUNCTION_NAME, Stage: 'LIVE' }));
    const etag = desc.ETag!;

    const code = renderCfFunction(blockedIps);
    const updated = await cf.send(new UpdateFunctionCommand({
        Name: CF_FUNCTION_NAME,
        IfMatch: etag,
        FunctionConfig: { Comment: 'Social redirect + IP block', Runtime: 'cloudfront-js-2.0' },
        FunctionCode: Buffer.from(code),
    }));

    await cf.send(new PublishFunctionCommand({
        Name: CF_FUNCTION_NAME,
        IfMatch: updated.ETag!,
    }));
}

export const handler = async (event: any) => {
    const isHttp = !!(event.rawPath && event.requestContext);

    const ok = (data: any) => isHttp
        ? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
        : data;

    const err = (status: number, message: string) => isHttp
        ? { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) }
        : { error: message };

    let action: 'list' | 'add' | 'remove';
    let ip: string | undefined;
    let reason: string | undefined;

    if (isHttp) {
        const method = event.requestContext?.http?.method;
        if (method === 'GET') {
            action = 'list';
        } else if (method === 'POST') {
            const body = event.body ? JSON.parse(event.body) : {};
            action = 'add';
            ip = body.ip;
            reason = body.reason;
        } else if (method === 'DELETE') {
            action = 'remove';
            ip = event.pathParameters?.ip ? decodeURIComponent(event.pathParameters.ip) : undefined;
        } else {
            return err(405, 'Method not allowed');
        }
    } else {
        action = event.action;
        ip = event.ip;
        reason = event.reason;
    }

    try {
        const entries = await readBlocklist();

        if (action === 'list') {
            return ok(entries.slice().sort((a, b) =>
                new Date(b.blockedAt).getTime() - new Date(a.blockedAt).getTime()
            ));
        }

        if (action === 'add' && ip) {
            if (entries.some(e => e.ip === ip)) return ok({ ok: true, alreadyBlocked: true });
            entries.push({ ip, blockedAt: new Date().toISOString(), reason: reason ?? '' });
            await writeBlocklist(entries);
            await redeployCfFunction(entries.map(e => e.ip));
            return ok({ ok: true, blocked: ip });
        }

        if (action === 'remove' && ip) {
            const filtered = entries.filter(e => e.ip !== ip);
            await writeBlocklist(filtered);
            await redeployCfFunction(filtered.map(e => e.ip));
            return ok({ ok: true, unblocked: ip });
        }

        return err(400, 'Invalid action');
    } catch (error) {
        console.error('Blocklist error:', error);
        return err(500, error instanceof Error ? error.message : 'Unknown error');
    }
};
