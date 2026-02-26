import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class AnalyticsStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly dbInstance: rds.DatabaseInstance;
    readonly dbSecret: rds.DatabaseSecret;
    readonly stagingBucket: s3.Bucket;
    readonly rdsSecurityGroup: ec2.SecurityGroup;
    readonly lambdaSecurityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

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

        // RDS t4g.micro PostgreSQL 16
        this.dbInstance = new rds.DatabaseInstance(this, 'AnalyticsDb', {
            engine: rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.VER_16,
            }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
            credentials: rds.Credentials.fromSecret(this.dbSecret),
            databaseName: 'analytics',
            vpc: this.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [this.rdsSecurityGroup],
            multiAz: false,
            allocatedStorage: 20,
            storageType: rds.StorageType.GP2,
            deletionProtection: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            // Disable automated backups (instance is stopped most of the time)
            backupRetention: cdk.Duration.days(0),
        });

        // S3 staging bucket: import-generate writes embedding JSON here;
        // import-execute Lambda (in VPC) reads it via the Gateway endpoint
        this.stagingBucket = new s3.Bucket(this, 'StagingBucket', {
            bucketName: 'nakomis-analytics-staging',
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            lifecycleRules: [{
                expiration: cdk.Duration.days(1),
                prefix: 'import-staging/',
            }],
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // SSM params for out-of-VPC Lambdas to find the RDS instance
        new ssm.StringParameter(this, 'DbEndpointParam', {
            parameterName: '/nakom-admin/rds/endpoint',
            stringValue: this.dbInstance.dbInstanceEndpointAddress,
        });
        new ssm.StringParameter(this, 'DbSecretArnParam', {
            parameterName: '/nakom-admin/rds/secret-arn',
            stringValue: this.dbSecret.secretArn,
        });
        new ssm.StringParameter(this, 'DbInstanceIdParam', {
            parameterName: '/nakom-admin/rds/instance-id',
            stringValue: this.dbInstance.instanceIdentifier,
        });
        new ssm.StringParameter(this, 'StagingBucketParam', {
            parameterName: '/nakom-admin/staging-bucket',
            stringValue: this.stagingBucket.bucketName,
        });
    }
}
