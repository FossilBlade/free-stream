import { Bell, Bookmark, Download, Film, Home, Search, Settings, Tv } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useProfile } from '../profile';
import { Avatar } from './Avatar';
import { FocusGroup, Focusable } from './Focusable';

const ITEMS: { path: string; label: string; icon: ReactNode; iconOnly?: boolean }[] = [
  { path: '/', label: 'Home', icon: <Home /> },
  { path: '/shows', label: 'Shows', icon: <Tv /> },
  { path: '/movies', label: 'Movies', icon: <Film /> },
  { path: '/my-list', label: 'My List', icon: <Bookmark /> },
  { path: '/search', label: 'Search', icon: <Search />, iconOnly: true },
  { path: '/watching', label: 'Watching', icon: <Bell />, iconOnly: true },
  { path: '/downloads', label: 'Downloads', icon: <Download />, iconOnly: true },
  { path: '/settings', label: 'Settings', icon: <Settings />, iconOnly: true },
];

const PHONE = '(max-width: 760px)';

/** True on phone-width screens (the TV and computers never match). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => !!window.matchMedia && window.matchMedia(PHONE).matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addListener(on); // addEventListener on MediaQueryList is too new for webOS 5
    return () => mq.removeListener(on);
  }, []);
  return phone;
}

export function Nav() {
  const phone = usePhone();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [solid, setSolid] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [healthFail, setHealthFail] = useState(false);
  const isKidProfile = useProfile().isKid;

  // Green dot on the bell when something being watched was found.
  useEffect(() => {
    if (isKidProfile) return;
    const check = () =>
      api
        .watching()
        .then((r) => setUnseen(r.unseen))
        .catch(() => {});
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, [pathname, isKidProfile]);

  // Red dot on Settings when the background health check found a failure (adults only).
  useEffect(() => {
    if (isKidProfile) return;
    const check = () =>
      api
        .status()
        .then((r) => setHealthFail(r.health === 'fail'))
        .catch(() => {});
    check();
    const t = setInterval(check, 5 * 60000);
    return () => clearInterval(t);
  }, [pathname, isKidProfile]);

  useEffect(() => {
    const onScroll = () => setSolid(window.pageYOffset > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const { profile, isKid } = useProfile();
  // Kids' profiles: no Watching, Downloads or Settings.
  const visible = ITEMS.filter((i) => !isKid || !['/watching', '/downloads', '/settings'].includes(i.path));
  // Phones: the main sections and Search go to a bottom tab bar; the top keeps the tool icons and avatar.
  const inBottom = (i: (typeof ITEMS)[number]) => !i.iconOnly || i.path === '/search';
  const main = visible.filter((i) => (phone ? inBottom(i) : !i.iconOnly));
  const tools = visible.filter((i) => (phone ? !inBottom(i) : i.iconOnly));
  const item = (i: (typeof ITEMS)[number]) => (
    <Focusable
      key={i.path}
      focusKey={`nav-${i.path}`}
      scroll="top"
      title={i.label}
      className={`nav-item${pathname === i.path ? ' is-active' : ''}${i.iconOnly && !(phone && inBottom(i)) ? ' nav-icon' : ''}`}
      onSelect={() => navigate(i.path)}
    >
      {i.icon}
      {i.path === '/watching' && unseen > 0 && <span className="nav-dot" aria-label={`${unseen} found`} />}
      {i.path === '/settings' && healthFail && <span className="nav-dot nav-dot-bad" aria-label="Health check found a problem" />}
      <span className={i.iconOnly && !(phone && inBottom(i)) ? 'sr-only' : 'nav-label'}>{i.label}</span>
    </Focusable>
  );

  return (
    <header className={`nav${solid ? ' is-solid' : ''}`}>
      <FocusGroup focusKey="nav" className="nav-inner">
        <div className="logo" aria-label="FreeStream">
          <span className="logo-mark" />
          Free<span>Stream</span>
        </div>
        <nav className={`nav-main${phone ? ' nav-bottom' : ''}`}>{main.map(item)}</nav>
        <div className="nav-tools">
          {tools.map(item)}
          {profile && (
            <Focusable focusKey="nav-profile" scroll="top" title={`${profile.name} — switch profile`} className="nav-item nav-icon nav-avatar" onSelect={() => navigate('/profiles')}>
              <Avatar p={profile} size="sm" />
            </Focusable>
          )}
        </div>
      </FocusGroup>
    </header>
  );
}
