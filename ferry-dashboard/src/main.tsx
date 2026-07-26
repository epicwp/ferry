import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { RequireAuth } from './layout';
import { AuthPage } from './pages/auth';
import { SitesPage } from './pages/sites';
import { NewSitePage } from './pages/new-site';
import { InstallPage } from './pages/install';
import { PairPage } from './pages/pair';
import { SyncPage } from './pages/sync';
import { SitePage } from './pages/site';
import './ui.css';

const router = createBrowserRouter([
  { path: '/login', element: <AuthPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <SitesPage /> },
      { path: '/sites/new', element: <NewSitePage /> },
      { path: '/sites/:id/install', element: <InstallPage /> },
      { path: '/sites/:id/pair', element: <PairPage /> },
      { path: '/sites/:id/sync', element: <SyncPage /> },
      { path: '/sites/:id', element: <SitePage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
