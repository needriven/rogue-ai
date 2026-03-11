import {
  createRouter,
  createRootRoute,
  createRoute,
} from '@tanstack/react-router'
import Root from '@/routes/Root'
import Home from '@/routes/Home'
import Game from '@/routes/Game'

// ── Routes ─────────────────────────────────────────────────────────────────
export const rootRoute = createRootRoute({ component: Root })

export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
})

export const gameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/game',
  component: Game,
})

// ── Router ─────────────────────────────────────────────────────────────────
const routeTree = rootRoute.addChildren([homeRoute, gameRoute])

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
})

// ── Type registration ──────────────────────────────────────────────────────
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
