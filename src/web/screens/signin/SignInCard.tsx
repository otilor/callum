import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api.js';
import { Button } from '../../ui/Button.js';
import { Wordmark } from '../../ui/Wordmark.js';
import './SignInCard.css';

/** The small card shown when the server wants a password. */
export function SignInCard({ onDone }: { onDone(): Promise<void> }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Callum kept everything as it was.');
    } finally {
      // If the page is still showing the card, the check is over, whatever came back.
      setBusy(false);
    }
  };

  return (
    <main className="signin" data-screen="sign-in">
      <form className="signin-card step-in" onSubmit={(e) => void submit(e)} aria-labelledby="signin-title">
        <Wordmark />
        <h1 id="signin-title">This Callum is private.</h1>
        <p>Enter the password you set when you installed it.</p>
        <label className="signin-field">
          <span className="sr-only">Password</span>
          <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        </label>
        {error ? <p className="signin-error" role="alert">{error}</p> : null}
        <Button type="submit" aria-busy={busy} disabled={busy || !password}>{busy ? 'Checking' : 'Sign in'}</Button>
      </form>
    </main>
  );
}
