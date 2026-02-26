export interface AdminConfig {
    aws: { region: string };
    cognito: {
        authority: string;
        userPoolId: string;
        userPoolClientId: string;
        cognitoDomain: string;
        redirectUri: string;
        logoutUri: string;
        identityPoolId: string;
    };
    apiEndpoint: string;
}

import configJson from './config.json';
const Config = configJson as AdminConfig;
export default Config;
