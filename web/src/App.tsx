import React from 'react';
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

const App: React.FC = () => {
    const auth = useAuth();
    const [tabId, setTabId] = React.useState(0);

    const signOutRedirect = () => {
        const logoutUrl = `https://${Config.cognito.cognitoDomain}/logout`
            + `?client_id=${Config.cognito.userPoolClientId}`
            + `&logout_uri=${encodeURIComponent(Config.cognito.logoutUri)}`;
        window.location.href = logoutUrl;
    };

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
                    <Box sx={{ bgcolor: '#1f2329', display: 'flex', alignItems: 'center' }}>
                        <Tabs
                            value={tabId}
                            onChange={(_, v) => setTabId(v)}
                            sx={{ '&& .Mui-selected': { color: '#d1d1d1' } }}
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
                    {tabId === 0 && <AnalyticsPage />}
                </Box>
            </ThemeProvider>
        );
    }

    return (
        <ThemeProvider theme={theme}>
            <Box sx={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', height: '100vh', bgcolor: '#121212',
            }}>
                <Typography variant="h5" sx={{ mb: 3, color: '#d1d1d1' }}>nakom-admin</Typography>
                <Button variant="contained" onClick={() => auth.signinRedirect()}>Sign in</Button>
            </Box>
        </ThemeProvider>
    );
};

export default App;
