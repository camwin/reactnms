import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bell, LayoutDashboard, Menu, Radar, Server, Settings, Waypoints } from 'lucide-react';
import { DiscoveryRibbon } from '@/components/nms/discovery-ribbon';
import { fetchAlertRules, fetchHealth } from '@/lib/api';
import { cn } from '@/lib/cn';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true, mobile: true },
  { to: '/devices', label: 'Devices', icon: Server, end: false, mobile: true },
  { to: '/topology', label: 'Topology', icon: Waypoints, end: true, mobile: true },
  { to: '/discovery', label: 'Discovery', icon: Radar, end: true, mobile: false },
  { to: '/alerts', label: 'Alerts', icon: Bell, end: true, mobile: true },
  { to: '/settings', label: 'Settings', icon: Settings, end: true, mobile: false },
] as const;

export default function Layout() {
  const path = useLocation().pathname;
  const [live, setLive] = useState<boolean | null>(null);
  const [enabledRules, setEnabledRules] = useState(0);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menuOpen = menuPath === path;
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuPath(null);
    }
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [menuOpen]);

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        await fetchHealth();
        if (!cancel) setLive(true);
      } catch {
        if (!cancel) setLive(false);
      }
      try {
        const rules = await fetchAlertRules();
        if (!cancel) setEnabledRules(rules.filter((rule) => rule.enabled !== false).length);
      } catch {
        if (!cancel) setEnabledRules(0);
      }
    }
    pull();
    const id = window.setInterval(pull, 15000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, []);

  const mobileNav = NAV.filter((item) => item.mobile);

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
        <div className="flex h-14 items-center justify-between gap-3 px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Mark />
            <div className="leading-none">
              <div className="text-sm font-semibold">ReactNMS</div>
              <div className="mt-1 font-mono text-xs text-faint">Network</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 font-mono text-xs text-muted">
              <span
                className={cn('size-1.5 rounded-full', live === false ? 'bg-down' : 'bg-accent', live === true && 'live-dot')}
                aria-hidden
              />
              {live === false ? <span className="text-down">Backend unreachable</span> : live === true ? 'Live' : 'Checking'}
            </div>
            <div className="relative lg:hidden" ref={menuRef}>
              <button
                type="button"
                className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
                aria-expanded={menuOpen}
                aria-label="More"
                onClick={() => setMenuPath((current) => (current === path ? null : path))}
              >
                <Menu className="size-5" strokeWidth={1.75} />
              </button>
              {menuOpen ? (
                <div role="menu" className="absolute right-0 top-12 z-40 w-48 rounded-xl border border-line bg-raised p-1">
                  {NAV.filter((item) => !item.mobile).map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      role="menuitem"
                      className={({ isActive }) =>
                        cn(
                          'flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm',
                          isActive ? 'bg-surface text-fg' : 'text-muted',
                        )
                      }
                    >
                      <item.icon className="size-4" strokeWidth={1.75} />
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] border-r border-line lg:block">
          <nav className="flex flex-col gap-1 p-3" aria-label="Primary">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm',
                    isActive ? 'bg-raised text-fg' : 'text-muted hover:bg-raised hover:text-fg',
                  )
                }
              >
                <item.icon className="size-4" strokeWidth={1.75} />
                <span className="flex-1">{item.label}</span>
                {item.to === '/alerts' && enabledRules > 0 ? (
                  <span className="rounded-full bg-down/15 px-2 py-0.5 font-mono text-xs tabular-nums text-down">
                    {enabledRules}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="mx-auto w-full max-w-6xl px-4 py-5 pb-28 lg:px-8 lg:pb-10">
          <DiscoveryRibbon />
          <Outlet />
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur safe-bottom lg:hidden"
        aria-label="Primary"
      >
        <ul className="grid grid-cols-4">
          {mobileNav.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'relative flex min-h-14 flex-col items-center justify-center gap-1 text-xs',
                    isActive ? 'text-accent' : 'text-faint',
                  )
                }
              >
                <item.icon className="size-5" strokeWidth={1.75} />
                {item.label}
                {item.to === '/alerts' && enabledRules > 0 ? (
                  <span className="absolute right-5 top-2 rounded-full bg-down px-1.5 font-mono text-xs leading-4 text-bg tabular-nums">
                    {enabledRules}
                  </span>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-raised" />
      <circle cx="9" cy="16" r="2.4" className="fill-accent" />
      <circle cx="22" cy="8.5" r="2.2" className="fill-fg" />
      <circle cx="23" cy="23.5" r="2.2" className="fill-fg" />
      <path
        d="M11.2 16H20M11.4 15.2 20.2 9.6M11.5 16.8 21 22.2"
        className="stroke-accent"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
