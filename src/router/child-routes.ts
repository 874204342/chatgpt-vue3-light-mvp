const LayoutDefault = () => import('@/components/Layout/default.vue')

const childrenRoutes: Array<RouteRecordRaw> = [
  {
    path: '/chat',
    component: LayoutDefault,
    name: 'ChatRoot',
    redirect: {
      name: 'ChatIndex'
    },
    children: [
      {
        path: '',
        name: 'ChatIndex',
        component: () => import('@/views/chat.vue')
      }
    ]
  },
  {
    path: '/card',
    name: 'CardPreview',
    component: () => import('@/views/card/index.vue')
  }
]

export default childrenRoutes
