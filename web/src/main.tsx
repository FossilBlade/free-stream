import { init } from '@noriginmedia/norigin-spatial-navigation';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { runBackHandlers } from './back';
import { Nav } from './components/Nav';
import { Toaster } from './components/Toast';
import { Browse, MyList } from './pages/Browse';
import { Downloads } from './pages/Downloads';
import { Home } from './pages/Home';
import { Player } from './pages/Player';
import { Search } from './pages/Search';
import { Settings } from './pages/Settings';
import { Title } from './pages/Title';
import { Watching } from './pages/Watching';
import { ManageProfiles, WhoIsWatching } from './pages/Profiles';
import { PersonPage } from './pages/Person';
import { ProfileProvider, useProfile } from './profile';
import { Spinner } from './components/ui';
import { isBackKey, isTV } from './tv';
import './styles.css';

init({
  // Faster key repeat feels better on a remote; throttling prevents runaway scrolling when a key is held.
  throttle: 90,
  throttleKeypresses: true,
});

if (isTV) document.documentElement.classList.add('tv');

function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const inPlayer = location.pathname.startsWith('/watch');
  const { profile, loaded } = useProfile();
  const onProfiles = location.pathname.startsWith('/profiles');

  // A device that hasn't picked a profile goes to "Who's watching?" first.
  useEffect(() => {
    if (loaded && !profile && !onProfiles) navigate('/profiles', { replace: true });
  }, [loaded, profile, onProfiles, navigate]);

  useEffect(() => {
    if (!inPlayer) window.scrollTo(0, 0);
  }, [location.pathname, inPlayer]);

  // Global Back: close the top-most overlay, else go back a page.
  useEffect(() => {
    if (inPlayer) return; // the player handles its own keys
    const onKey = (e: KeyboardEvent) => {
      if (!isBackKey(e)) return;
      e.preventDefault();
      if (runBackHandlers()) return;
      const idx = (window.history.state as { idx?: number } | null)?.idx;
      if (idx && idx > 0) navigate(-1);
      else if (location.pathname !== '/') navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inPlayer, navigate, location.pathname]);

  return (
    <>
      {!inPlayer && !(onProfiles && !location.pathname.endsWith('/manage')) && profile && <Nav />}
      <main>{!loaded ? <Spinner /> : <Outlet key={profile?.id || 'none'} />}</main>
      <Toaster />
    </>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/shows', element: <Browse key="tv" type="tv" /> },
      { path: '/movies', element: <Browse key="movie" type="movie" /> },
      { path: '/my-list', element: <MyList /> },
      { path: '/search', element: <Search /> },
      { path: '/downloads', element: <Downloads /> },
      { path: '/watching', element: <Watching /> },
      { path: '/profiles', element: <WhoIsWatching /> },
      { path: '/profiles/manage', element: <ManageProfiles /> },
      { path: '/person/:id', element: <PersonPage /> },
      { path: '/settings', element: <Settings /> },
      { path: '/title/:type/:id', element: <Title /> },
      { path: '/watch/:type/:id', element: <Player /> },
      { path: '*', element: <Home /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProfileProvider>
      <RouterProvider router={router} />
    </ProfileProvider>
  </StrictMode>,
);
