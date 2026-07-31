import { NavLink } from 'react-router-dom';

const navLinkClass = ({ isActive }) =>
  `no-underline hover:text-almanac-accent ${isActive ? 'text-almanac-accent' : 'text-almanac-mute'}`;

const chromeButtonClass =
  'bg-transparent border-0 p-0 cursor-pointer text-almanac-mute hover:text-almanac-accent';

// The one bar every screen shares -- brand, nav, the light/dark override,
// and logout -- so they're reachable no matter which screen is on top
// (previously ItemDetail had none of these, see developer-handover.md §10b).
export default function AlmanacShell({ onToggleMode, loggedIn, onLogout, children }) {
  return (
    <div className="min-h-screen bg-almanac-bg text-almanac-ink font-body transition-colors">
      <header className="flex items-center justify-between gap-4 px-5 py-3 bg-almanac-panel border-b border-almanac-border">
        <span className="font-display text-base tracking-wide">Almanac</span>
        <div className="flex items-center gap-5 text-sm">
          {loggedIn && (
            <>
              <NavLink to="/" end className={navLinkClass}>
                Due &amp; reviews
              </NavLink>
              <NavLink to="/history" className={navLinkClass}>
                History
              </NavLink>
            </>
          )}
          <button type="button" onClick={onToggleMode} className={chromeButtonClass}>
            &#9728; / &#9790;
          </button>
          {loggedIn && (
            <button type="button" onClick={onLogout} className={chromeButtonClass}>
              Log out
            </button>
          )}
        </div>
      </header>
      <div className="max-w-3xl mx-auto px-6 py-8">{children}</div>
    </div>
  );
}
