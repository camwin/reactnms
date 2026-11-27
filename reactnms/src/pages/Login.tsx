import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiUrl, fetchAuthConfig, login, type AuthPublic } from '@/lib/api';

function nextPath(raw: string | null) {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = nextPath(params.get('next'));
  const [config, setConfig] = useState<AuthPublic | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancel = false;
    fetchAuthConfig()
      .then((body) => {
        if (!cancel) setConfig(body);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not read authentication');
      });
    return () => {
      cancel = true;
    };
  }, []);

  const mode = config?.mode || 'off';

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 text-fg">
      <form
        className="w-full max-w-md rounded-xl border border-line bg-surface px-5 py-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === 'off') {
            navigate(next);
            return;
          }
          setBusy(true);
          setError('');
          login(username.trim(), password)
            .then(() => navigate(next))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Sign-in failed'))
            .finally(() => setBusy(false));
        }}
      >
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-muted">
          {mode === 'off' ? 'Authentication is off.' : null}
          {mode === 'local' ? 'Use a local username and password.' : null}
          {mode === 'ad' ? 'Use your Active Directory account.' : null}
          {mode === 'ldap' ? 'Use your LDAP account.' : null}
          {mode === 'sso' ? 'Continue with single sign-on.' : null}
        </p>
        {mode === 'sso' ? (
          <Button type="button" tone="solid" className="mt-4" onClick={() => window.location.assign(apiUrl(`/api/auth/sso/start?next=${encodeURIComponent(next)}`))}>
            Continue
          </Button>
        ) : mode === 'off' ? (
          <Button type="submit" tone="solid" className="mt-4">Continue</Button>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <Input aria-label="Username" placeholder="Username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            <Input aria-label="Password" type="password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            <Button type="submit" tone="solid" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </div>
        )}
        {error ? <p className="mt-3 text-sm text-down">{error}</p> : null}
      </form>
    </div>
  );
}
