import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { CognitoStack } from './cognito-stack';
import { DeployEnv, getEnvConfig } from './env-config';

export interface ApiStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
    cognitoStack: CognitoStack;
}

export class ApiStack extends cdk.Stack {
    readonly api: apigwv2.HttpApi;

    constructor(scope: Construct, id: string, props: ApiStackProps) {
        super(scope, id, props);

        const { cognitoStack } = props;
        const config = getEnvConfig(props.deployEnv);

        // --- HTTP API ---
        this.api = new apigwv2.HttpApi(this, 'AdminApi', {
            apiName: 'nakom-admin-api',
            corsPreflight: {
                allowOrigins: [`https://${config.domainName}`, 'http://localhost:5173'],
                allowMethods: [
                    apigwv2.CorsHttpMethod.GET,
                    apigwv2.CorsHttpMethod.POST,
                    apigwv2.CorsHttpMethod.DELETE,
                    apigwv2.CorsHttpMethod.OPTIONS,
                ],
                allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256'],
                maxAge: cdk.Duration.days(1),
            },
        });


        const authorizer = new authorizers.HttpIamAuthorizer();

        cognitoStack.authenticatedRole.addToPolicy(new iam.PolicyStatement({
            actions: ['execute-api:Invoke'],
            resources: [this.api.arnForExecuteApi('*', '/*', '*')],
        }));

        const bundling = { minify: true, sourceMap: true };
        const runtime = lambda.Runtime.NODEJS_22_X;
        const account = this.account;
        const region = this.region;

        // rds-control, the EventBridge scheduler role and the Aurora grants
        // that used to live here are gone with AnalyticsStack (ADMIN-10). They
        // existed to start and stop a cluster that cost money to leave
        // running; the console's data is now on Luke, which is on anyway.

        // --- cvchat-forward Lambda (ADMIN-6) ---
        //
        // Replaces import-generate. That function embedded each record with
        // Bedrock Titan and staged it in S3 for import-execute to load into
        // Aurora; this one age-encrypts the record and puts it on an SQS queue
        // for Cal, which embeds with the estate's single model and writes to
        // Luke's pgvector. See lambda/cvchat-forward/handler.ts for why the
        // embedding had to move rather than merely being cheaper elsewhere.
        //
        // Config comes from the SSM parameters CvChatIngestStack publishes in
        // the home-servers CDK app (same account), resolved at *deploy* time
        // as CloudFormation dynamic references.
        //
        // Not valueFromLookup, which reads SSM during synth: that needs
        // credentials in the target account just to produce a template, so it
        // breaks `cdk synth` for anyone without them and breaks CI outright —
        // and it bakes the value into cdk.context.json, where a later change
        // to the parameter is silently ignored until someone clears the cache.
        // A dynamic reference costs nothing at synth and fails at deploy with
        // a clear CloudFormation error if the parameter is missing, which is
        // the correct ordering signal: this stack cannot deploy before
        // CvChatIngestStack has.
        const cvchatParam = (name: string) =>
            ssm.StringParameter.valueForStringParameter(this, `/cv-chat/${props.deployEnv}/${name}`);

        const cvchatQueueUrl = cvchatParam('queue-url');
        const cvchatPayloadBucket = cvchatParam('payload-bucket');

        const cvchatForward = new nodejs.NodejsFunction(this, 'CvChatForwardFn', {
            functionName: 'nakom-admin-cvchat-forward',
            entry: 'lambda/cvchat-forward/handler.ts',
            handler: 'handler',
            runtime,
            memorySize: 256,
            // Unchanged from import-generate at 300s, but for a different
            // reason: that budget used to be dominated by a Bedrock call per
            // record. This function only encrypts and enqueues, so the time
            // now goes on a backlog of batches — which is what makes the full
            // corpus replay (ADMIN-7) able to run through this same path.
            timeout: cdk.Duration.seconds(300),
            bundling,
            environment: {
                CHAT_LOGS_TABLE: 'cv-chat-logs',
                IMPORT_CURSOR_PARAM: '/nakom.is/analytics/CVCHAT/last-imported-timestamp',
                CVCHAT_QUEUE_URL: cvchatQueueUrl,
                PAYLOAD_BUCKET: cvchatPayloadBucket,
                // The consumer's age *public* key. A recipient is not a
                // secret — it can only encrypt — so it lives in the
                // environment rather than in Secrets Manager. The matching
                // identity never leaves Cal.
                AGE_RECIPIENT: ssm.StringParameter.valueForStringParameter(
                    this,
                    `/conversation-memory/${props.deployEnv}/age-recipient`,
                ),
            },
        });

        // Read cv-chat-logs DDB table (same account, eu-west-2)
        cvchatForward.addToRolePolicy(new iam.PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [`arn:aws:dynamodb:${region}:${account}:table/cv-chat-logs`],
        }));
        // SSM read/write for the import cursor
        cvchatForward.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:PutParameter'],
            resources: [
                `arn:aws:ssm:${region}:${account}:parameter/nakom.is/analytics/CVCHAT/last-imported-timestamp`,
            ],
        }));
        // Send on the ingest queue, and claim-check writes under the cvchat/
        // prefix. Attached as the managed policy CvChatIngestStack publishes,
        // rather than written out again here: the grant is defined next to the
        // queue it grants on, and neither CDK app needs the other's construct
        // tree. That policy is deliberately send-only and carries no rights at
        // all on the conversation-memory queue — a compromise of this
        // public-facing pipeline must not reach the private corpus.
        cvchatForward.role!.addManagedPolicy(
            iam.ManagedPolicy.fromManagedPolicyArn(
                this,
                'CvChatForwarderPolicy',
                cvchatParam('forwarder-policy-arn'),
            ),
        );

        // No Bedrock grant. Its absence is the enforcement of the one-model
        // invariant — see the handler's module docs.

        // import-execute and the query Lambda are gone too (ADMIN-10). Both
        // ran inside AnalyticsStack's VPC purely to reach Aurora — which is
        // also why this stack no longer needs ec2 or a VPC at all. Their work
        // is done by Cal's /cvchat endpoints, reached over the mTLS bridge
        // rather than over a private subnet.

        // --- monitor-logs Lambda ---
        const monitorLogs = new nodejs.NodejsFunction(this, 'MonitorLogsFn', {
            functionName: 'nakom-admin-monitor-logs',
            entry: 'lambda/monitor-logs/handler.ts',
            handler: 'handler',
            runtime,
            memorySize: 256,
            timeout: cdk.Duration.seconds(120),
            bundling,
            environment: {
                CF_LOGS_BUCKET: 'nakomis-cf-access-logs',
                CHAT_LOGS_TABLE: 'cv-chat-logs',
            },
        });

        monitorLogs.addToRolePolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [
                'arn:aws:s3:::nakomis-cf-access-logs',
                'arn:aws:s3:::nakomis-cf-access-logs/*',
            ],
        }));
        monitorLogs.addToRolePolicy(new iam.PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [`arn:aws:dynamodb:${region}:${account}:table/cv-chat-logs`],
        }));

        // --- blocklist Lambda ---
        const blocklist = new nodejs.NodejsFunction(this, 'BlocklistFn', {
            functionName: 'nakom-admin-blocklist',
            entry: 'lambda/blocklist/handler.ts',
            handler: 'handler',
            runtime,
            memorySize: 128,
            timeout: cdk.Duration.seconds(30),
            bundling,
            environment: {
                BLOCKED_IPS_PARAM: '/nakom.is/blocked-ips',
            },
        });

        blocklist.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:PutParameter'],
            resources: [`arn:aws:ssm:${region}:${account}:parameter/nakom.is/blocked-ips`],
        }));
        blocklist.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'cloudfront:DescribeFunction',
                'cloudfront:UpdateFunction',
                'cloudfront:PublishFunction',
                'cloudfront:GetFunction',
            ],
            resources: [`arn:aws:cloudfront::${account}:function/nakomis-social-redirect`],
        }));

        // --- Routes ---
        const addRoute = (method: apigwv2.HttpMethod, path: string, fn: nodejs.NodejsFunction) => {
            this.api.addRoutes({
                path,
                methods: [method],
                integration: new integrations.HttpLambdaIntegration(`${fn.node.id}-${method}-${path.replace(/\//g, '-')}`, fn),
                authorizer,
            });
        };


        // Kept at the same path so the console's "forward new records" button
        // did not have to move. /rds/*, /query/{type} and /import/execute are
        // gone with Aurora (ADMIN-9/10); what is left here is what never
        // depended on it — the CloudFront log miner and the DynamoDB blocklist.
        addRoute(apigwv2.HttpMethod.POST, '/import/generate', cvchatForward);


        addRoute(apigwv2.HttpMethod.POST, '/logs/mine', monitorLogs);

        addRoute(apigwv2.HttpMethod.GET, '/blocklist', blocklist);
        addRoute(apigwv2.HttpMethod.POST, '/blocklist', blocklist);
        addRoute(apigwv2.HttpMethod.DELETE, '/blocklist/{ip}', blocklist);

        // --- Custom Domain ---
        const zone = route53.HostedZone.fromLookup(this, 'Zone', {
            domainName: config.zoneName,
        });

        const apiCert = new acm.Certificate(this, 'ApiCert', {
            domainName: config.apiDomainName,
            validation: acm.CertificateValidation.fromDns(zone),
        });

        const customDomain = new apigwv2.DomainName(this, 'ApiCustomDomain', {
            domainName: config.apiDomainName,
            certificate: apiCert,
        });

        new apigwv2.ApiMapping(this, 'ApiMapping', {
            api: this.api,
            domainName: customDomain,
            stage: this.api.defaultStage!,
        });

        new route53.ARecord(this, 'ApiARecord', {
            zone,
            recordName: 'api.admin',
            target: route53.RecordTarget.fromAlias(
                new targets.ApiGatewayv2DomainProperties(
                    customDomain.regionalDomainName,
                    customDomain.regionalHostedZoneId,
                ),
            ),
        });
        new route53.AaaaRecord(this, 'ApiAaaaRecord', {
            zone,
            recordName: 'api.admin',
            target: route53.RecordTarget.fromAlias(
                new targets.ApiGatewayv2DomainProperties(
                    customDomain.regionalDomainName,
                    customDomain.regionalHostedZoneId,
                ),
            ),
        });

        // Output the API endpoint via both SSM and CloudFormation output
        new ssm.StringParameter(this, 'ApiEndpointParam', {
            parameterName: '/nakom-admin/api-endpoint',
            stringValue: this.api.apiEndpoint,
        });
        new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint });
        new cdk.CfnOutput(this, 'ApiCustomDomainUrl', { value: `https://${customDomain.name}` });
    }
}
