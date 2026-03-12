import { createRouter, createRootRoute, createRoute } from '@tanstack/react-router'
import Root     from '@/routes/Root'
import Home     from '@/routes/Home'
import Game     from '@/routes/Game'
import Feed     from '@/routes/Feed'
import Settings from '@/routes/Settings'

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

export const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/feed',
  component: Feed,
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: Settings,
})

const routeTree = rootRoute.addChildren([homeRoute, gameRoute, feedRoute, settingsRoute])

export const router = createRouter({ routeTree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
