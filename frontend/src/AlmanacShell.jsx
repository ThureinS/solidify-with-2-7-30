import { NavLink } from 'react-router-dom';

const navLinkClass = ({ isActive }) =>
  `no-underline whitespace-nowrap hover:text-almanac-accent ${isActive ? 'text-almanac-accent' : 'text-almanac-mute'}`;

const chromeButtonClass =
  'bg-transparent border-0 p-0 cursor-pointer whitespace-nowrap text-almanac-mute hover:text-almanac-accent';

// The one bar every screen shares -- brand, nav, the light/dark override,
// and logout -- so they're reachable no matter which screen is on top
// (previously ItemDetail had none of these, see developer-handover.md §10b).
export default function AlmanacShell({ onToggleMode, loggedIn, onLogout, children }) {
  return (
    <div className="min-h-screen bg-almanac-bg text-almanac-ink font-body transition-colors">
      <header className="flex items-center justify-between flex-wrap gap-x-4 gap-y-2 px-5 py-3 bg-almanac-panel border-b border-almanac-border">
        {/* "Almanac" is the name of the *palette* (indigo night sky, moon-phase
            history), not of the product -- it told a visitor nothing about what
            this app does. The wordmark now says what it is; the almanac-* color
            tokens keep their name, since those are internal and renaming them
            would touch every className for no user-visible gain. */}
        <span className="font-display text-base tracking-wide whitespace-nowrap">
          Spaced Repetition Tracker
        </span>
        <div className="flex items-center flex-wrap gap-x-5 gap-y-2 text-sm">
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
