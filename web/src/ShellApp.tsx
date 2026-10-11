import { useEffect, useMemo, useState } from 'react';
import { AuthContext, type AuthContextProps } from 'react-oidc-context';
import App from './App';
import type { ShellContext } from './shell-contract';

// Tokens are short-lived (1 h); re-read them from the shell well before then.
const TOKEN_REFRESH_MS = 4 * 60 * 1000;

interface Tokens {
    access_token: string;
    id_token: string;
}

/**
 * Module Federation entry (`admin/App`) for nakomis-shell. The shell owns sign-in, so instead of an
 * oidc AuthProvider we feed App the shell's tokens through react-oidc-context's own context.
 */
export default function ShellApp(shell: ShellContext) {
    const [tokens, setTokens] = useState<Tokens>();
    const [error, setError] = useState<Error>();

    useEffect(() => {
        let cancelled = false;
        const load = () =>
            Promise.all([shell.getAccessToken(), shell.getIdToken()]).then(
                ([access_token, id_token]) => {
                    if (!cancelled) setTokens((t) => (t?.id_token === id_token ? t : { access_token, id_token }));
                },
                (err: Error) => !cancelled && setError(err),
            );
        void load();
        const timer = setInterval(load, TOKEN_REFRESH_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [shell]);

    const auth = useMemo(
        () =>
            ({
                isLoading: !tokens && !error,
                isAuthenticated: Boolean(tokens),
                error,
                user: tokens && {
                    ...tokens,
                    profile: { sub: shell.user.sub, email: shell.user.email, 'cognito:username': shell.user.username },
                },
                removeUser: async () => {},
                signoutRedirect: async () => shell.signOut(),
                signinRedirect: async () => {},
            }) as unknown as AuthContextProps,
        [tokens, error, shell],
    );

    return (
        <AuthContext.Provider value={auth}>
            <App onSignOut={shell.signOut} />
        </AuthContext.Provider>
    );
}
