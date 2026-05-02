import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ShieldCheck } from 'lucide-react';

import { login, verifyTotp } from '@/api/auth';
import { useAuth } from '@/store/auth';
import { showToast } from '@/components/ui/Toast';

// LoginPage: two-step. Step 1 = email + password → /login.  Step 2 = 6-digit
// TOTP → /totp/verify. The page maintains the challenge token in local
// component state; once we hand off the access token to the auth store, we
// navigate to the dashboard.

type Step =
  | { kind: 'creds' }
  | { kind: 'totp'; challengeToken: string; otpauthUrl?: string };

export function LoginPage() {
  const nav = useNavigate();
  const setSession = useAuth((s) => s.setSession);
  const [step, setStep] = useState<Step>({ kind: 'creds' });
  const [shake, setShake] = useState(0);

  if (step.kind === 'totp') {
    return (
      <Wrapper>
        <TotpForm
          step={step}
          shakeKey={shake}
          onShake={() => setShake((n) => n + 1)}
          onSuccess={async (token, expiresAt, admin) => {
            setSession(token, expiresAt, admin);
            nav('/', { replace: true });
          }}
          onBack={() => setStep({ kind: 'creds' })}
        />
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <CredsForm
        shakeKey={shake}
        onShake={() => setShake((n) => n + 1)}
        onChallenge={(challengeToken, otpauthUrl) =>
          setStep({ kind: 'totp', challengeToken, otpauthUrl })
        }
      />
    </Wrapper>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-4">
            <ShieldCheck className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Zopmop CRM</h1>
          <p className="text-sm text-text-secondary mt-1">Admin sign-in</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function CredsForm({
  shakeKey,
  onShake,
  onChallenge,
}: {
  shakeKey: number;
  onShake: () => void;
  onChallenge: (challengeToken: string, otpauthUrl?: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await login(email, password);
      onChallenge(res.challenge_token, res.otpauth_url);
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error;
      if (status === 423) setErr(msg ?? 'account locked — try again later');
      else setErr(msg ?? 'invalid credentials');
      onShake();
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.form
      key={shakeKey}
      onSubmit={submit}
      className={`card p-6 ${err ? 'animate-shake' : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Email</label>
      <input
        className={`input mb-4 ${err ? 'border-danger' : ''}`}
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoFocus
      />
      <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Password</label>
      <input
        className={`input ${err ? 'border-danger' : ''}`}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      <button className="btn-primary w-full mt-6" type="submit" disabled={busy}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
    </motion.form>
  );
}

function TotpForm({
  step,
  shakeKey,
  onShake,
  onSuccess,
  onBack,
}: {
  step: { kind: 'totp'; challengeToken: string; otpauthUrl?: string };
  shakeKey: number;
  onShake: () => void;
  onSuccess: (token: string, expiresAt: string, admin: import('@/store/auth').Admin) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function tryVerify(value: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await verifyTotp(step.challengeToken, value);
      onSuccess(res.access_token, res.expires_at, res.admin);
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error;
      setErr(msg ?? 'invalid code');
      setCode('');
      onShake();
      showToast({ kind: 'error', message: msg ?? 'invalid code' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      key={shakeKey}
      className={`card p-6 ${err ? 'animate-shake' : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <p className="text-sm text-text-secondary mb-4">
        Enter the 6-digit code from your authenticator app.
      </p>
      {step.otpauthUrl && (
        <div className="card-elevated p-4 mb-4">
          <p className="text-xs text-text-secondary mb-2">First-time setup — scan in Google Authenticator:</p>
          <code className="block text-xs font-mono text-text-primary break-all">{step.otpauthUrl}</code>
        </div>
      )}
      <input
        className={`input text-center tracking-[0.4em] text-xl font-mono ${err ? 'border-danger' : ''}`}
        type="text"
        inputMode="numeric"
        maxLength={6}
        autoFocus
        value={code}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 6);
          setCode(v);
          if (v.length === 6) void tryVerify(v);
        }}
      />
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      <div className="flex justify-between mt-6">
        <button className="btn-ghost" onClick={onBack} disabled={busy}>← Back</button>
        <button
          className="btn-primary"
          onClick={() => code.length === 6 && void tryVerify(code)}
          disabled={busy || code.length !== 6}
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </div>
    </motion.div>
  );
}
