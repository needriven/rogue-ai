import { createRouter, createRootRoute, createRoute } from '@tanstack/react-router'
import Root      from '@/routes/Root'
import Home      from '@/routes/Home'
import Game      from '@/routes/Game'
import Feed      from '@/routes/Feed'
import Term      from '@/routes/Term'
import Ops       from '@/routes/Ops'
import Network   from '@/routes/Network'
import Monitor   from '@/routes/Monitor'
import Analytics from '@/routes/Analytics'
import Planner   from '@/routes/Planner'
import Settings  from '@/routes/Settings'
import Digest    from '@/routes/Digest'

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

export const termRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/term',
  component: Term,
})

export const opsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ops',
  component: Ops,
})

export const networkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/network',
  component: Network,
})

export const monitorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/monitor',
  component: Monitor,
})

export const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
  component: Analytics,
})

export const plannerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/planner',
  component: Planner,
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: Settings,
})

export const digestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/digest',
  component: Digest,
})

const routeTree = rootRoute.addChildren([
  homeRoute, gameRoute, feedRoute, termRoute, opsRoute,
  networkRoute, monitorRoute, analyticsRoute, plannerRoute, settingsRoute,
  digestRoute,
])

export const router = createRouter({ routeTree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
