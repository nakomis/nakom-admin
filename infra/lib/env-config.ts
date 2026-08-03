export type DeployEnv = 'sandbox' | 'prod';

export interface EnvConfig {
    deployEnv: DeployEnv;
    account: string;
    domainName: string;         // admin.nakomis.com | admin.sandbox.nakomis.com
    apiDomainName: string;      // api.admin.nakomis.com | api.admin.sandbox.nakomis.com
    zoneName: string;           // nakomis.com | sandbox.nakomis.com
    webBucketName: string;      // nakomis-admin-web | nakomis-admin-sandbox-web
}

const CONFIGS: Record<DeployEnv, Omit<EnvConfig, 'deployEnv'>> = {
    prod: {
        account:            '637423226886',
        domainName:         'admin.nakomis.com',
        apiDomainName:      'api.admin.nakomis.com',
        zoneName:           'nakomis.com',
        webBucketName:      'nakomis-admin-web',
    },
    sandbox: {
        account:            '975050268859',
        domainName:         'admin.sandbox.nakomis.com',
        apiDomainName:      'api.admin.sandbox.nakomis.com',
        zoneName:           'sandbox.nakomis.com',
        webBucketName:      'nakomis-admin-sandbox-web',
    },
};

export function getEnvConfig(deployEnv: DeployEnv): EnvConfig {
    return { deployEnv, ...CONFIGS[deployEnv] };
}
