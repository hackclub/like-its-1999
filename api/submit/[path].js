import { createFerry } from '@jeremy46231/ferry'

export const ferry = createFerry({ basePath: '/api/submit' })

export default {
  async fetch(request) {
    return (
      (await ferry.handle(request)) ??
      new Response('Not found', { status: 404 })
    )
  },
}
