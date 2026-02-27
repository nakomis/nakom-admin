import React, { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import AppBar from '@mui/material/AppBar';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { ThemeProvider } from '@mui/material/styles';
import { theme } from './theme';
import Config from './config/config';
import AnalyticsPage from './components/pages/AnalyticsPage';
import { CognitoIdentityClient, Credentials, GetCredentialsForIdentityCommand, GetIdCommand } from '@aws-sdk/client-cognito-identity';

const App: React.FC = () => {
    const auth = useAuth();
    const [creds, setCreds] = React.useState<Credentials | null>(null);
    const [tabId, setTabId] = React.useState(0);

    const signOutRedirect = () => {
        const logoutUrl = `https://${Config.cognito.cognitoDomain}/logout`
            + `?client_id=${Config.cognito.userPoolClientId}`
            + `&logout_uri=${encodeURIComponent(Config.cognito.logoutUri)}`;
        window.location.href = logoutUrl;
    };

    async function getAWSCredentialsFromIdToken(
        region: string,
        identityPoolId: string,
        idToken: string
    ): Promise<Credentials | undefined> {
        const client = new CognitoIdentityClient({ region });
        const providerName = Config.cognito.authority.replace(/^https:\/\//, "");


        // Step 1: Get the Cognito Identity ID
        const getIdCommand = new GetIdCommand({
            IdentityPoolId: identityPoolId,
            Logins: {
                [providerName]: idToken,
            },
        });
        const getIdResponse = await client.send(getIdCommand);

        if (!getIdResponse.IdentityId) return undefined;

        // Step 2: Get AWS Credentials for the Identity ID
        const getCredsCommand = new GetCredentialsForIdentityCommand({
            IdentityId: getIdResponse.IdentityId,
            Logins: {
                [providerName]: idToken,
            },
        });
        const getCredsResponse = await client.send(getCredsCommand);

        return getCredsResponse.Credentials;
    }

    useEffect(() => {
        if (!auth.user?.id_token) {
            return;
        }
        (async () => {
            const credentials = await getAWSCredentialsFromIdToken(
                Config.aws.region,
                Config.cognito.identityPoolId,
                auth.user?.id_token || ''
            );
            setCreds(credentials ?? null);
        })();
    }, [auth.user?.id_token]);

    if (auth.isLoading) {
        return (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
                <Typography>Loading...</Typography>
            </Box>
        );
    }

    if (auth.error) {
        return (
            <Box sx={{ p: 4 }}>
                <Typography color="error">Auth error: {auth.error.message}</Typography>
            </Box>
        );
    }

    if (auth.isAuthenticated) {
        return (
            <ThemeProvider theme={theme}>
                <AppBar position="static">
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <Tabs
                            value={tabId}
                            onChange={(_, v) => setTabId(v)}
                        >
                            <Tab label="Analytics" />
                        </Tabs>
                        <Box sx={{ flexGrow: 1 }} />
                        <Button
                            color="inherit"
                            sx={{ mr: 1 }}
                            onClick={() => { auth.removeUser(); signOutRedirect(); }}
                        >
                            Sign out
                        </Button>
                    </Box>
                </AppBar>
                <Box sx={{ bgcolor: 'background.default', minHeight: 'calc(100vh - 48px)' }}>
                    {tabId === 0 && <AnalyticsPage creds={creds!} />}
                </Box>
            </ThemeProvider>
        );
    }

    return (
        <ThemeProvider theme={theme}>
            <Box sx={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', height: '100vh',
            }}>
                <Typography variant="h5" sx={{ mb: 3 }}>nakom-admin</Typography>
                <Button variant="contained" onClick={() => auth.signinRedirect()}>Sign in</Button>
            </Box>
        </ThemeProvider>
    );
};

export default App;
