/**
 * A faux desktop window (traffic-light dots + title bar + optional title-bar
 * actions), shared by the Sample Application and Sample Server frames so the
 * page reads as two separate programs side by side.
 */
import "./window-frame.scss";

interface WindowFrameProps {
  title: string;
  /** Accessible name for the region; must not collide with inner regions. */
  label: string;
  className?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function WindowFrame({
  title,
  label,
  className,
  actions,
  children,
}: WindowFrameProps): React.JSX.Element {
  return (
    <section
      className={className ? `app-window ${className}` : "app-window"}
      aria-label={label}
    >
      <div className="app-window-chrome">
        <span className="app-window-dots" aria-hidden="true">
          <span className="app-window-dot" />
          <span className="app-window-dot" />
          <span className="app-window-dot" />
        </span>
        <h2 className="app-window-title">{title}</h2>
        {actions && <span className="app-window-actions">{actions}</span>}
      </div>
      <div className="app-window-body">{children}</div>
    </section>
  );
}
