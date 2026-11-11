# Stateless container for Google Cloud Run. Writes no files at runtime: all state is in Supabase.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    TRUST_PROXY=true
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY supabase ./supabase
# Run as the unprivileged "node" user; the filesystem is not written to.
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
