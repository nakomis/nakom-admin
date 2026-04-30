import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DeployEnv, getEnvConfig } from './env-config';

export interface GithubCiStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
    githubOidcProviderArn: string;
}

export class GithubCiStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: GithubCiStackProps) {
        super(scope, id, props);

        const { deployEnv, githubOidcProviderArn } = props;
        const config = getEnvConfig(deployEnv);

        const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this, 'GithubOidcProvider', githubOidcProviderArn,
        );

        const ciRole = new iam.Role(this, 'GithubCiRole', {
            roleName: `nakomis-nakom-admin-github-ci-${deployEnv}`,
            assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
                StringEquals: {
                    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                },
                StringLike: {
                    'token.actions.githubusercontent.com:sub': 'repo:nakomis/nakom-admin:*',
                },
            }),
        });

        // CDK deploy: assume bootstrap roles in this account
        ciRole.addToPolicy(new iam.PolicyStatement({
            actions: ['sts:AssumeRole'],
            resources: [`arn:aws:iam::${config.account}:role/cdk-hnb659fds-*`],
        }));

        // Web deploy: sync SPA to S3 — import bucket by name to avoid cross-stack reference
        const webBucket = s3.Bucket.fromBucketName(this, 'WebBucket', config.webBucketName);
        webBucket.grantReadWrite(ciRole);
        ciRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [webBucket.bucketArn],
        }));
        ciRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:DeleteObject'],
            resources: [`${webBucket.bucketArn}/*`],
        }));

        // Web deploy: CloudFront invalidation — scoped to this account's distributions
        ciRole.addToPolicy(new iam.PolicyStatement({
            actions: ['cloudfront:CreateInvalidation'],
            resources: [`arn:aws:cloudfront::${config.account}:distribution/*`],
        }));

        // Web deploy: read SSM params to generate config.json
        ciRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: [`arn:aws:ssm:${this.region}:${config.account}:parameter/nakom-admin/*`],
        }));

        new cdk.CfnOutput(this, 'CiRoleArn', { value: ciRole.roleArn });
    }
}
