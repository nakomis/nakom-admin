import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class CognitoStack extends cdk.Stack {
    readonly userPool: cognito.UserPool;
    readonly userPoolClient: cognito.UserPoolClient;
    readonly identityPool: cognito.CfnIdentityPool;
    readonly authenticatedRole: iam.Role;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.userPool = new cognito.UserPool(this, 'AdminUserPool', {
            userPoolName: 'nakom-admin-users',
            selfSignUpEnabled: false,
            signInAliases: { username: true, email: true },
            mfa: cognito.Mfa.OPTIONAL,
            mfaSecondFactor: { otp: true, sms: false },
            passwordPolicy: {
                minLength: 12,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
            },
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.userPoolClient = this.userPool.addClient('AdminWebClient', {
            oAuth: {
                flows: { authorizationCodeGrant: true },
                scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
                callbackUrls: ['https://admin.nakom.is/loggedin', 'http://localhost:5173/loggedin'],
                logoutUrls: ['https://admin.nakom.is/logout', 'http://localhost:5173/logout'],
            },
            supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
        });

        this.userPool.addDomain('AdminCognitoDomain', {
            cognitoDomain: { domainPrefix: 'auth-nakom-admin' },
        });

        this.identityPool = new cognito.CfnIdentityPool(this, 'AdminIdentityPool', {
            identityPoolName: 'nakom_admin_identity',
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [{
                clientId: this.userPoolClient.userPoolClientId,
                providerName: this.userPool.userPoolProviderName,
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
    }
}
