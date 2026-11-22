import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Devices = lazy(() => import('./pages/Devices'));
const Topology = lazy(() => import('./pages/Topology'));
const Discovery = lazy(() => import('./pages/Discovery'));
const Alerts = lazy(() => import('./pages/Alerts'));
const DeviceDetail = lazy(() => import('./pages/DeviceDetail'));
const DeviceSettings = lazy(() => import('./pages/DeviceSettings'));
const Settings = lazy(() => import('./pages/Settings'));

function Loading() {
  return <div style={{ padding: 40, color: '#94a3b8' }}>Loading…</div>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Suspense fallback={<Loading />}><Dashboard /></Suspense>} />
          <Route path="/devices" element={<Suspense fallback={<Loading />}><Devices /></Suspense>} />
          <Route path="/topology" element={<Suspense fallback={<Loading />}><Topology /></Suspense>} />
          <Route path="/discovery" element={<Suspense fallback={<Loading />}><Discovery /></Suspense>} />
          <Route path="/alerts" element={<Suspense fallback={<Loading />}><Alerts /></Suspense>} />
          <Route path="/devices/:ip" element={<Suspense fallback={<Loading />}><DeviceDetail /></Suspense>} />
          <Route path="/devices/:ip/settings" element={<Suspense fallback={<Loading />}><DeviceSettings /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={<Loading />}><Settings /></Suspense>} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
