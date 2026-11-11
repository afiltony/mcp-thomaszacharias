/* Runtime config. Hosted on the Node server: API is same-origin, path routes.
 * The hero video is served from assets/media (MEDIA_DIR on the server); if it is missing the
 * home hero falls back to the drawn network artwork. Set heroVideo: false to never request it.
 * scripts/build-ipfs.mjs overwrites this in the IPFS build with { apiBase: "https://<api host>", router: "hash" }. */
window.TZ_CONFIG = window.TZ_CONFIG || { apiBase: '', router: 'path', heroVideo: true };
