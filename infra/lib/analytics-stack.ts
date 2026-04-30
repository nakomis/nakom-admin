import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DeployEnv, getEnvConfig } from './env-config';

export interface AnalyticsStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
}

export class AnalyticsStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly dbCluster: rds.DatabaseCluster;
    readonly dbSecret: rds.DatabaseSecret;
    readonly stagingBucket: s3.Bucket;
    readonly rdsSecurityGroup: ec2.SecurityGroup;
    readonly lambdaSecurityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
        super(scope, id, props);

        const config = getEnvConfig(props.deployEnv);

        // VPC — no NAT, isolated private subnets only
        this.vpc = new ec2.Vpc(this, 'AnalyticsVpc', {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [{
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                name: 'Private',
                cidrMask: 24,
            }],
        });

        // Free S3 Gateway endpoint — allows in-VPC Lambdas to reach S3
        this.vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });

        // Security groups
        this.rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSg', {
            vpc: this.vpc,
            description: 'nakom-admin RDS PostgreSQL',
            allowAllOutbound: false,
        });

        this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
            vpc: this.vpc,
            description: 'nakom-admin VPC Lambdas',
            allowAllOutbound: true,
        });

        this.rdsSecurityGroup.addIngressRule(
            this.lambdaSecurityGroup,
            ec2.Port.tcp(5432),
            'Allow VPC Lambdas to connect to PostgreSQL',
        );

        // RDS credentials (stored in Secrets Manager, resolved at CloudFormation deploy time)
        this.dbSecret = new rds.DatabaseSecret(this, 'DbSecret', {
            username: 'analytics',
            secretName: 'nakom-admin/rds/analytics',
        });

        // Aurora Serverless v2 PostgreSQL cluster.
        // serverlessV2MinCapacity=0 enables auto-pause when idle (scales to 0 ACUs, no charge),
        // auto-resumes on first connection. The cluster is never "stopped", so it does not
        // hit the 7-day auto-restart that affects stopped RDS instances.
        //
        // Use fromPassword (not fromSecret) so CDK doesn't create a second SecretTargetAttachment
        // for the same secret — Secrets Manager only allows one attachment per secret, and the
        // old RDS instance already has one. The cluster uses the same username/password.
        this.dbCluster = new rds.DatabaseCluster(this, 'AnalyticsCluster', {
            engine: rds.DatabaseClusterEngine.auroraPostgres({
                version: rds.AuroraPostgresEngineVersion.VER_16_4,
            }),
            writer: rds.ClusterInstance.serverlessV2('writer'),
            serverlessV2MinCapacity: 0,
            serverlessV2MaxCapacity: 1,
            credentials: rds.Credentials.fromPassword(
                'analytics',
                this.dbSecret.secretValueFromJson('password'),
            ),
            defaultDatabaseName: 'analytics',
            vpc: this.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [this.rdsSecurityGroup],
            deletionProtection: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            backup: { retention: cdk.Duration.days(1) },
        });

        // S3 staging bucket: import-generate writes embedding JSON here;
        // import-execute Lambda (in VPC) reads it via the Gateway endpoint
        this.stagingBucket = new s3.Bucket(this, 'StagingBucket', {
            bucketName: config.stagingBucketName,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            cors: [
                {
                    // Allow the admin frontend (prod and local dev) to fetch embedding-export objects directly with SigV4
                    allowedOrigins: [`https://${config.domainName}`, 'http://localhost:5173'],
                    allowedMethods: [s3.HttpMethods.GET],
                    allowedHeaders: ['*'],
                    maxAge: 3000,
                },
            ],
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(1),
                    prefix: 'import-staging/',
                },
                {
                    // Embedding exports are one-shot downloads; clean up after a week
                    expiration: cdk.Duration.days(7),
                    prefix: 'embedding-export/',
                },
            ],
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // SSM params for out-of-VPC Lambdas to find the Aurora cluster
        new ssm.StringParameter(this, 'DbEndpointParam', {
            parameterName: '/nakom-admin/rds/endpoint',
            stringValue: this.dbCluster.clusterEndpoint.hostname,
        });
        new ssm.StringParameter(this, 'DbSecretArnParam', {
            parameterName: '/nakom-admin/rds/secret-arn',
            stringValue: this.dbSecret.secretArn,
        });
        new ssm.StringParameter(this, 'DbInstanceIdParam', {
            parameterName: '/nakom-admin/rds/instance-id',
            stringValue: this.dbCluster.clusterIdentifier,
        });
        new ssm.StringParameter(this, 'StagingBucketParam', {
            parameterName: '/nakom-admin/staging-bucket',
            stringValue: this.stagingBucket.bucketName,
        });

        // Consumed by nakomis-status to check Aurora cluster health without VPC access
        new ssm.StringParameter(this, 'StatusCheckInstanceIdParam', {
            parameterName: '/nakomis-status/rds/analytics-instance-id',
            stringValue: this.dbCluster.clusterIdentifier,
        });
    }
}
