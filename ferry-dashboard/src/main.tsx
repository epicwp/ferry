import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { RequireAuth } from './layout';
import { AuthPage } from './pages/auth';
import { SitesPage } from './pages/sites';
import './ui.css';

const router = createBrowserRouter([
  { path: '/login', element: <AuthPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <SitesPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
