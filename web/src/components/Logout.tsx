import { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { useNavigate } from 'react-router';

export default function Logout() {
    const auth = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        auth.removeUser().then(() => navigate('/'));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return null;
}
