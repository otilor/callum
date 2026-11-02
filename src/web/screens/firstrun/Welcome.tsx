import { Button } from '../../ui/Button.js';
import { ChatIcon, ClockIcon, ShieldIcon } from './icons.js';

export function Welcome({ onContinue }: { onContinue(provider: 'google' | 'microsoft'): void }) {
  return (
    <section className="fr-step fr-welcome step-in" aria-labelledby="q0">
      <div className="fr-welcome-head">
        <h1 id="q0" className="fr-title fr-title-xl">Callum reaches out for you.</h1>
        <p className="fr-lede">It only taps you when someone wants to talk.</p>
      </div>
      <ul className="fr-promises">
        <li><ChatIcon />Sounds like you</li>
        <li><ShieldIcon />Safe daily limits</li>
        <li><ClockIcon />Running in five minutes</li>
      </ul>
      <div className="fr-actions">
        <Button size="lg" onClick={() => onContinue('google')}>Continue with Google</Button>
        <Button size="lg" variant="quiet" onClick={() => onContinue('microsoft')}>Continue with Microsoft</Button>
      </div>
      <p className="fr-quiet">Callum sends from your own accounts and never sees your passwords.</p>
    </section>
  );
}
