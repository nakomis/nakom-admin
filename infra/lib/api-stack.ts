import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { CognitoStack } from './cognito-stack';
import { AnalyticsStack } from './analytics-stack';

export interface ApiStackProps extends cdk.StackProps {
    cognitoStack: CognitoStack;
    analyticsStack: AnalyticsStack;
}

export class ApiStack extends cdk.Stack {
    readonly api: apigwv2.HttpApi;

    constructor(scope: Construct, id: string, props: ApiStackProps) {
        super(scope, id, props);

        const { cognitoStack, analyticsStack } = props;

        // --- HTTP API ---
        this.api = new apigwv2.HttpApi(this, 'AdminApi', {
            apiName: 'nakom-admin-api',
            corsPreflight: {
                allowOrigins: ['https://admin.nakom.is', 'http://localhost:5173'],
                allowMethods: [
                    apigwv2.CorsHttpMethod.GET,
                    apigwv2.CorsHttpMethod.POST,
                    apigwv2.CorsHttpMethod.DELETE,
                    apigwv2.CorsHttpMethod.OPTIONS,
                ],
                allowHeaders: ['Content-Type', 'Authorization'],
                maxAge: cdk.Duration.days(1),
            },
        });

        const authorizer = new authorizers.HttpJwtAuthorizer(
            'CognitoAuthorizer',
            `https://cognito-idp.${this.region}.amazonaws.com/${cognitoStack.userPool.userPoolId}`,
            {
                jwtAudience: [cognitoStack.userPoolClient.userPoolClientId],
            },
        );

        const defaultAuthOptions: apigwv2.AddRoutesOptions = {
            authorizer,
        } as unknown as apigwv2.AddRoutesOptions;

        const bundling = { minify: true, sourceMap: true };
        const runtime = lambda.Runtime.NODEJS_20_X;
        const account = this.account;
        const region = this.region;

        // --- rds-control Lambda ---
        const rdsControl = new nodejs.NodejsFunction(this, 'RdsControlFn', {
            functionName: 'nakom-admin-rds-control',
            entry: 'lambda/rds-control/handler.ts',
            handler: 'handler',
            runtime,
            memorySize: 128,
            timeout: cdk.Duration.seconds(60),
            bundling,
        });

        rdsControl.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'rds:StartDBInstance',
                'rds:StopDBInstance',
                'rds:CreateDBSnapshot',
                'rds:DeleteDBSnapshot',
                'rds:DescribeDBSnapshots',
                'rds:DescribeDBInstances',
                'rds:RestoreDBInstanceFromDBSnapshot',
            ],
            resources: [
                analyticsStack.dbInstance.instanceArn,
                `arn:aws:rds:${region}:${account}:snapshot:*`,
            ],
        }));
        // SSM reads for RDS instance ID and secret ARN
        rdsControl.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: [
                `arn:aws:ssm:${region}:${account}:parameter/nakom-admin/rds/*`,
            ],
        }));

        // --- import-generate Lambda ---
        const importGenerate = new nodejs.NodejsFunction(this, 'ImportGenerateFn', {
            functionName: 'nakom-admin-import-generate',
            entry: 'lambda/import-generate/handler.ts',
            handler: 'handler',
            runtime,
            memorySize: 256,
            timeout: cdk.Duration.seconds(300),
            bundling,
            environment: {
                CHAT_LOGS_TABLE: 'nakomis-chat-logs',
                STAGING_BUCKET: analyticsStack.stagingBucket.bucketName,
                IMPORT_CURSOR_PARAM: '/nakom.is/analytics/CVCHAT/last-imported-timestamp',
                IMPORT_EXECUTE_FUNCTION_NAME: 'nakom-admin-import-execute',
            },
        });

        // Read nakomis-chat-logs DDB table (same account, eu-west-2)
        importGenerate.addToRolePolicy(new iam.PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [`arn:aws:dynamodb:${region}:${account}:table/nakomis-chat-logs`],
        }));
        // Bedrock Titan Embed v2
        importGenerate.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: [`arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`],
        }));
        // S3 write to staging bucket
        analyticsStack.stagingBucket.grantWrite(importGenerate, 'import-staging/*');
        // SSM read/write for import cursor
        importGenerate.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:PutParameter'],
            resources: [
                `arn:aws:ssm:${region}:${account}:parameter/nakom.is/analytics/CVCHAT/last-imported-timestamp`,
            ],
        }));
        // Invoke import-execute async
        importGenerate.addToRolePolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [`arn:aws:lambda:${region}:${account}:function:nakom-admin-import-execute`],
        }));

        // --- import-execute Lambda (in VPC) ---
        const importExecute = new nodejs.NodejsFunction(this, 'ImportExecuteFn', {
            functionName: 'nakom-admin-import-execute',
            entry: 'lambda/import-execute/handler.ts',
            handler: 'handler',
            runtime,
            memorySize: 256,
            timeout: cdk.Duration.seconds(300),
            bundling,
            vpc: analyticsStack.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [analyticsStack.lambdaSecurityGroup],
            environment: {
                STAGING_BUCKET: analyticsStack.stagingBucket.bucketName,
                DB_ENDPOINT: analyticsStack.dbInstance.dbInstanceEndpointAddress,
                DB_NAME: 'analytics',
                DB_USERNAME: 'analytics',
                DB_PASSWORD: analyticsStack.dbSecret.secretValueFromJson('password').unsafeUnwrap(),
            },
        });

        // S3 read from staging bucket (via VPC Gateway endpoint)
        analyticsStack.stagingBucket.grantRead(importExecute, 'import-staging/*');

        // --- query Lambda (in VPC) ---
        const queryFn = new nodejs.NodejsFunction(this, 'QueryFn', {
            functionName: 'nakom-admin-query',
            entry: 'lambda/query/handler.ts',
            handler: 'handler',
            runtime,
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            bundling,
            vpc: analyticsStack.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [analyticsStack.lambdaSecurityGroup],
            environment: {
                DB_ENDPOINT: analyticsStack.dbInstance.dbInstanceEndpointAddress,
                DB_NAME: 'analytics',
                DB_USERNAME: 'analytics',
                DB_PASSWORD: analyticsStack.dbSecret.secretValueFromJson('password').unsafeUnwrap(),
            },
        });

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
                CF_LOGS_BUCKET_PARAM: '/nakom.is/cf-access-logs-bucket',
                CHAT_LOGS_TABLE: 'nakomis-chat-logs',
            },
        });

        monitorLogs.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: [`arn:aws:ssm:${region}:${account}:parameter/nakom.is/cf-access-logs-bucket`],
        }));
        monitorLogs.addToRolePolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [
                'arn:aws:s3:::nakomis-cf-access-logs',
                'arn:aws:s3:::nakomis-cf-access-logs/*',
            ],
        }));
        monitorLogs.addToRolePolicy(new iam.PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [`arn:aws:dynamodb:${region}:${account}:table/nakomis-chat-logs`],
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
                'cloudfront:DescribeFunctions',
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

        addRoute(apigwv2.HttpMethod.GET, '/rds/status', rdsControl);
        addRoute(apigwv2.HttpMethod.GET, '/rds/snapshots', rdsControl);
        addRoute(apigwv2.HttpMethod.POST, '/rds/start', rdsControl);
        addRoute(apigwv2.HttpMethod.POST, '/rds/stop', rdsControl);
        addRoute(apigwv2.HttpMethod.POST, '/rds/snapshot', rdsControl);
        addRoute(apigwv2.HttpMethod.POST, '/rds/restore', rdsControl);

        addRoute(apigwv2.HttpMethod.POST, '/import/generate', importGenerate);
        addRoute(apigwv2.HttpMethod.POST, '/import/execute', importExecute);

        addRoute(apigwv2.HttpMethod.GET, '/query/{type}', queryFn);

        addRoute(apigwv2.HttpMethod.POST, '/logs/mine', monitorLogs);

        addRoute(apigwv2.HttpMethod.GET, '/blocklist', blocklist);
        addRoute(apigwv2.HttpMethod.POST, '/blocklist', blocklist);
        addRoute(apigwv2.HttpMethod.DELETE, '/blocklist/{ip}', blocklist);

        // Output the API endpoint
        new ssm.StringParameter(this, 'ApiEndpointParam', {
            parameterName: '/nakom-admin/api-endpoint',
            stringValue: this.api.apiEndpoint,
        });
    }
}
