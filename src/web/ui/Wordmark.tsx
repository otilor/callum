import './ui.css';

/** The Sun dot: a sun-yellow disc on the baseline, then `callum` in Onest 700. */
export function Wordmark({ project }: { project?: string | null }) {
  return (
    <span className="wordmark">
      <span className="wm-lockup">
        <span className="wm-dot" aria-hidden="true" />
        <span className="wm-word">callum</span>
      </span>
      {project ? (
        <>
          <span className="wm-sep" aria-hidden="true">·</span>
          <span className="wm-project" data-testid="project-anchor">{project}</span>
        </>
      ) : null}
    </span>
  );
}
