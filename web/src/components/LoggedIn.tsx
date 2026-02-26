import { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { useNavigate } from 'react-router';

// Callback page — OIDC library handles token exchange; redirect to home after
export default function LoggedIn() {
    const auth = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        if (!auth.isLoading) navigate('/');
    }, [auth.isLoading, navigate]);

    return null;
}
