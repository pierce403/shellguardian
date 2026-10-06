// Transport only. All application content remains static assets.
/** @type {ExportedHandler<Env>} */
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:') {
      return Response.redirect(`https://shellguardian.org${url.pathname}${url.search}`, 308);
    }
    return env.ASSETS.fetch(request);
  },
};
