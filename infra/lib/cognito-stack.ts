import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DeployEnv, getEnvConfig } from './env-config';

export interface CognitoStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
}

export class CognitoStack extends cdk.Stack {
    readonly userPool: cognito.IUserPool;
    readonly userPoolClient: cognito.UserPoolClient;
    readonly identityPool: cognito.CfnIdentityPool;
    readonly authenticatedRole: iam.Role;
    readonly loginDomain: string;

    constructor(scope: Construct, id: string, props: CognitoStackProps) {
        super(scope, id, props);

        const { deployEnv } = props;
        const config = getEnvConfig(deployEnv);

        // Reference the canonical shared user pool from nakomis-infra via SSM
        const userPoolId = ssm.StringParameter.valueForStringParameter(
            this, `/nakomis-infra/${deployEnv}/cognito/user-pool-id`,
        );
        this.loginDomain = ssm.StringParameter.valueForStringParameter(
            this, `/nakomis-infra/${deployEnv}/cognito/login-domain`,
        );

        this.userPool = cognito.UserPool.fromUserPoolId(this, 'SharedUserPool', userPoolId);

        this.userPoolClient = this.userPool.addClient('AdminWebClient', {
            userPoolClientName: `nakom-admin-${deployEnv}`,
            oAuth: {
                flows: { authorizationCodeGrant: true },
                scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
                callbackUrls: [`https://${config.domainName}/loggedin`, 'http://localhost:5173/loggedin'],
                logoutUrls: [`https://${config.domainName}/logout`, 'http://localhost:5173/logout'],
            },
            supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
        });

        this.identityPool = new cognito.CfnIdentityPool(this, 'AdminIdentityPool', {
            identityPoolName: `nakom_admin_${deployEnv}`,
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [{
                clientId: this.userPoolClient.userPoolClientId,
                providerName: `cognito-idp.${this.region}.amazonaws.com/${userPoolId}`,
            }],
        });

        this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
            assumedBy: new iam.FederatedPrincipal(
                'cognito-identity.amazonaws.com',
                {
                    StringEquals: { 'cognito-identity.amazonaws.com:aud': this.identityPool.ref },
                    'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
                },
                'sts:AssumeRoleWithWebIdentity',
            ),
        });

        new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoles', {
            identityPoolId: this.identityPool.ref,
            roles: { authenticated: this.authenticatedRole.roleArn },
        });

        // SSM params consumed by the web deploy script (set-config.sh) to generate config.json
        new ssm.StringParameter(this, 'UserPoolIdParam', {
            parameterName: '/nakom-admin/cognito/user-pool-id',
            stringValue: userPoolId,
        });
        new ssm.StringParameter(this, 'ClientIdParam', {
            parameterName: '/nakom-admin/cognito/client-id',
            stringValue: this.userPoolClient.userPoolClientId,
        });
        new ssm.StringParameter(this, 'IdentityPoolIdParam', {
            parameterName: '/nakom-admin/cognito/identity-pool-id',
            stringValue: this.identityPool.ref,
        });
        new ssm.StringParameter(this, 'LoginDomainParam', {
            parameterName: '/nakom-admin/cognito/login-domain',
            stringValue: this.loginDomain,
        });
        new ssm.StringParameter(this, 'AppDomainParam', {
            parameterName: '/nakom-admin/app-domain',
            stringValue: config.domainName,
        });

        new cdk.CfnOutput(this, 'UserPoolId', { value: userPoolId });
        new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
        new cdk.CfnOutput(this, 'IdentityPoolId', { value: this.identityPool.ref });
    }
}
