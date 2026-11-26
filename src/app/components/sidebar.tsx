import { Link, NavLink, useLocation } from 'react-router-dom';
import { ROUTE_META } from '../routes/route-meta';

/** Visible label for a route: the part of the title before the em dash. */
function labelFor(title: string): string {
  return title.split('—')[0].trim();
}

/**
 * Primary navigation.
 *
 * Route links expose `aria-current="page"` for the active route. Profile uses a
 * computed Link because `/profile` is an alias for `/`; the remaining routes use
 * exact-match NavLinks. Accessible names are exactly Profile, Dashboard,
 * Calculators, Insurance, Plan, Goals, ESOP and Assistant.
 */
export function Sidebar({ navId, onNavigate }: { navId?: string; onNavigate?: () => void }) {
  const location = useLocation();
  const profileActive = location.pathname === '/' || location.pathname === '/profile';

  const linkClass = (active: boolean) =>
    [
      'block rounded-md px-3 py-2 text-sm font-medium no-underline transition-colors',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-secondary)',
      active
        ? 'bg-(--color-surface-raised) text-(--color-primary)'
        : 'text-(--color-muted-foreground) hover:bg-(--color-surface-raised) hover:text-(--color-foreground)',
    ].join(' ');

  return (
    <nav id={navId} aria-label="Primary" className="flex flex-col gap-1 p-3">
      {ROUTE_META.map((meta) => (
        meta.path === '/' ? (
          <Link
            key={meta.id}
            to={meta.path}
            aria-current={profileActive ? 'page' : undefined}
            onClick={onNavigate}
            className={linkClass(profileActive)}
          >
            {labelFor(meta.title)}
          </Link>
        ) : (
          <NavLink
            key={meta.id}
            to={meta.path}
            end
            onClick={onNavigate}
            className={({ isActive }) => linkClass(isActive)}
          >
            {labelFor(meta.title)}
          </NavLink>
        )
      ))}
    </nav>
  );
}
