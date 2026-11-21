const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname !== '/api/health') {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404, headers });
    }
    if (request.method !== 'GET') {
      return Response.json(
        { error: 'METHOD_NOT_ALLOWED' },
        { status: 405, headers: { ...headers, Allow: 'GET' } },
      );
    }
    return Response.json({ service: 'agent-commons', status: 'ok', stage: 1 }, { headers });
  },
} satisfies ExportedHandler;
