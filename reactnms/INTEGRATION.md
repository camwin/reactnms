# Add these to your existing ReactNMS

## 1. Copy files
- `src/pages/Discovery.tsx` → into your frontend
- Backend files into `reactnms-backend/`

## 2. Update Layout.tsx navItems
```tsx
{ to: '/discovery', icon: Radar, label: 'Discovery' },
```
(import Radar from lucide-react)

## 3. Update App.tsx routes
```tsx
<Route path="/discovery" element={
  <Suspense fallback={<Loading />}>
    <Discovery />
  </Suspense>
} />
```
(import Discovery from './pages/Discovery')

## 4. Backend
```bash
cd reactnms-backend
npm install
npm start
```

## 5. Frontend
Restart `npm run dev`. Discovery appears in the sidebar.
